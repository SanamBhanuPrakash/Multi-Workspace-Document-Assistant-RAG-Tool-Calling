import { describe, expect, it, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { closePool, pool, withSystem, withTenant, withUser } from "@/infra/db/client";
import { chunks, documents, memberships, EMBEDDING_DIMENSIONS } from "@/infra/db/schema";
import { addDoc, axisVector, count, forgeScope, makeUser, makeWorkspace } from "../helpers/db";
import { afterAll } from "vitest";
import { safeError } from "@/infra/logging/logger";

afterAll(async () => {
  await withSystem((tx) => tx.execute(sql`DELETE FROM documents WHERE title = 'bulk'`)); // don't pollute later files
  await closePool();
});

/** Drizzle wraps driver errors; assert on the real Postgres error (and, in passing, that safeError never leaks params). */
async function expectPgError(p: Promise<unknown>, re?: RegExp): Promise<void> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err, "expected the statement to be rejected").toBeDefined();
  const safe = safeError(err);
  expect(safe.message).not.toContain("params:");
  if (re) expect(safe.message).toMatch(re);
}

/**
 * Layer 3 of the isolation defence: these tests bypass ALL application code and attack the database directly,
 * as a buggy or forged caller would. If any of them fails, tenant isolation no longer holds.
 */
describe("RLS: tenant isolation at the database layer", () => {
  let alice: string, bob: string, wsA: string, wsB: string;

  beforeAll(async () => {
    alice = await makeUser("alice");
    bob = await makeUser("bob");
    wsA = await makeWorkspace(alice, "Alpha");
    wsB = await makeWorkspace(bob, "Beta");
    await addDoc(forgeScope(alice, wsA), { text: "The vault code is ZEBRA-4417.", axis: 1 });
    await addDoc(forgeScope(bob, wsB), { text: "Beta only fact.", axis: 2 });
  });

  it("the app role cannot bypass RLS and is not a superuser", async () => {
    const r = await pool().query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'lattice_app'");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("schema lint: every table with a workspace_id column has RLS enabled and at least one policy", async () => {
    const r = await pool().query<{ table_name: string; rls: boolean; policies: string }>(`
      SELECT c.table_name, cl.relrowsecurity AS rls,
             (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.table_name)::text AS policies
      FROM information_schema.columns c
      JOIN pg_class cl ON cl.relname = c.table_name AND cl.relnamespace = 'public'::regnamespace
      WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id'`);
    expect(r.rows.length).toBeGreaterThan(8);
    for (const row of r.rows) {
      expect(row.rls, `${row.table_name} must have RLS enabled`).toBe(true);
      expect(Number(row.policies), `${row.table_name} must have policies`).toBeGreaterThan(0);
    }
  });

  it("a workspace sees ONLY its own chunks even with an unfiltered SELECT *", async () => {
    const seenByA = await withTenant(forgeScope(alice, wsA), (tx) => tx.execute<{ workspace_id: string }>(sql`SELECT workspace_id FROM chunks`));
    expect(seenByA.rows.length).toBe(1);
    expect(new Set(seenByA.rows.map((r) => r.workspace_id))).toEqual(new Set([wsA]));

    const seenByB = await withTenant(forgeScope(bob, wsB), (tx) => tx.execute<{ content: string }>(sql`SELECT content FROM chunks`));
    expect(seenByB.rows.map((r) => r.content)).toEqual(["Beta only fact."]);
  });

  it("vector search WITHOUT a workspace filter still cannot see foreign chunks (forgotten-WHERE bug)", async () => {
    const q = `[${axisVector(1).join(",")}]`; // exactly Alpha's vector
    const asBob = await withTenant(forgeScope(bob, wsB), (tx) =>
      tx.execute<{ content: string }>(sql`SELECT content FROM chunks ORDER BY embedding <=> ${q}::vector LIMIT 5`),
    );
    expect(asBob.rows.map((r) => r.content)).not.toContain("The vault code is ZEBRA-4417.");
    // SAFETY property only. How many of Bob's OWN rows come back is ANN recall, not isolation: an approximate (HNSW) scan
    // returns its nearest candidates, RLS then drops the foreign ones, and Bob's row can be missed when many closer foreign
    // vectors exist (this failed once in a full-suite run while passing alone 3/3; see PROJECT_LOG). Production retrieval
    // never relies on this path — it searches EXACTLY inside the workspace (chunkStore.hybridSearch).
    expect(asBob.rows.length).toBeLessThanOrEqual(1);
    expect(asBob.rows.every((r) => r.content === "Beta only fact.")).toBe(true);
  });

  it("RLS-only vector query (no app-level filter) NEVER leaks foreign rows, even beside thousands of closer ones", async () => {
    // This is the BACKSTOP path (a query that forgot its WHERE clause). HNSW applies RLS after the graph traversal, so this
    // path is allowed to under-return — outlier rows can be unreachable — but it must never return a foreign row. Recall
    // for real queries is guaranteed elsewhere: hybridSearch searches exactly within the workspace (see retrieval tests).
    const carol = await makeUser("carol");
    const wsCarol = await makeWorkspace(carol, "Carol");
    const dave = await makeUser("dave");
    const wsDave = await makeWorkspace(dave, "Dave");
    await addDoc(forgeScope(dave, wsDave), { text: "dave's only chunk", axis: 400 });
    const q = `[${axisVector(9).join(",")}]`;
    await withSystem(async (tx) => {
      const d = await tx.execute<{ id: string }>(sql`
        INSERT INTO documents (workspace_id, title, filename, mime, size_bytes, content_hash, status, created_by)
        VALUES (${wsCarol}::uuid, 'bulk', 'bulk', 't', 1, ${`bulk-${randomUUID()}`}, 'ready', ${carol}) RETURNING id`);
      await tx.execute(sql`
        INSERT INTO chunks (workspace_id, document_id, ordinal, content, token_count, embedding, embedding_model)
        SELECT ${wsCarol}::uuid, ${d.rows[0]!.id}::uuid, g, 'carol distractor', 1,
               ARRAY(SELECT x + random() * 0.05 + g * 0 FROM unnest((${q}::vector)::real[]) AS x)::vector, 't'
        FROM generate_series(1, 3000) g`);
      await tx.execute(sql`ANALYZE chunks`);
    });
    const asDave = await withTenant(forgeScope(dave, wsDave), (tx) =>
      tx.execute<{ content: string }>(sql`SELECT content FROM chunks ORDER BY embedding <=> ${q}::vector LIMIT 5`),
    );
    for (const row of asDave.rows) expect(row.content).toBe("dave's only chunk"); // never a foreign row (may be empty)
  });

  it("FORGED scope: a user naming a workspace they do not belong to gets nothing (DB-side membership check)", async () => {
    const forged = forgeScope(bob, wsA); // application check bypassed on purpose
    await withTenant(forged, async (tx) => {
      expect(await count(tx, "chunks")).toBe(0);
      expect(await count(tx, "documents")).toBe(0);
      // `workspaces` is user-scoped by design (bob may list his own Beta) — but Alpha's row must be invisible.
      const alpha = await tx.execute(sql`SELECT id FROM workspaces WHERE id = ${wsA}`);
      expect(alpha.rows.length).toBe(0);
    });
  });

  it("fails CLOSED: no scope settings ⇒ zero rows", async () => {
    const c = await pool().connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE lattice_app");
      for (const t of ["chunks", "documents", "messages", "tool_calls", "tasks", "workspaces", "memberships"]) {
        const r = await c.query(`SELECT count(*)::int AS n FROM ${t}`);
        expect(r.rows[0].n, `${t} must be empty without scope`).toBe(0);
      }
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("user-only scope (no active workspace) sees no workspace-scoped rows", async () => {
    await withUser(alice, async (tx) => {
      expect(await count(tx, "chunks")).toBe(0);
      expect(await count(tx, "documents")).toBe(0);
      expect(await count(tx, "workspaces")).toBe(1); // but does see own workspace list
    });
  });

  it("cannot WRITE a chunk into another workspace", async () => {
    const { documentId } = await addDoc(forgeScope(bob, wsB), { text: "b2", axis: 3 });
    await expectPgError(
      withTenant(forgeScope(bob, wsB), (tx) =>
        tx.insert(chunks).values({
          workspaceId: wsA, // attempt to plant content in Alpha
          documentId,
          ordinal: 9,
          content: "planted",
          tokenCount: 1,
          embedding: axisVector(5),
          embeddingModel: "t",
        }),
      ),
      /row-level security/i,
    );
  });

  it("composite FK: a chunk's workspace can never disagree with its document's workspace (even for the owner role)", async () => {
    const { documentId } = await addDoc(forgeScope(alice, wsA), { text: "a2", axis: 4 });
    await expectPgError(
      withSystem((tx) =>
        tx.insert(chunks).values({
          workspaceId: wsB,
          documentId, // belongs to Alpha
          ordinal: 7,
          content: "mismatch",
          tokenCount: 1,
          embedding: axisVector(6),
          embeddingModel: "t",
        }),
      ),
      /chunks_doc_ws_fk|foreign key/i,
    );
  });

  it("cannot self-join someone else's workspace", async () => {
    await expectPgError(withUser(bob, (tx) => tx.insert(memberships).values({ workspaceId: wsA, userId: bob, role: "owner" })), /row-level security/i);
    await expectPgError(
      withTenant(forgeScope(bob, wsB), (tx) => tx.insert(memberships).values({ workspaceId: wsA, userId: bob, role: "member" })),
      /row-level security/i,
    );
  });

  it("cannot read or update another workspace's documents by id", async () => {
    const { documentId } = await addDoc(forgeScope(alice, wsA), { text: "a3", axis: 7 });
    await withTenant(forgeScope(bob, wsB), async (tx) => {
      const rows = await tx.select().from(documents).where(sql`${documents.id} = ${documentId}`);
      expect(rows.length).toBe(0);
      const upd = await tx.execute(sql`UPDATE documents SET title = 'pwned' WHERE id = ${documentId} RETURNING id`);
      expect(upd.rows.length).toBe(0);
      const del = await tx.execute(sql`DELETE FROM documents WHERE id = ${documentId} RETURNING id`);
      expect(del.rows.length).toBe(0);
    });
  });

  it("identity tables are unreachable from the tenant role", async () => {
    await withTenant(forgeScope(alice, wsA), async (tx) => {
      await expectPgError(tx.execute(sql`SELECT email FROM "user"`), /permission denied/i);
    });
  });

  it("sanity: embedding dimension is the documented constant", () => {
    expect(EMBEDDING_DIMENSIONS).toBe(768);
    expect(randomUUID()).toBeTruthy();
  });
});
