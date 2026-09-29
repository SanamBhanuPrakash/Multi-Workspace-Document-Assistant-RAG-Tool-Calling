import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { TenantScope, Role } from "@/core/security/tenant";
import { withSystem, withUser, withTenant, type Tx } from "@/infra/db/client";
import { EMBEDDING_DIMENSIONS, documents, chunks, memberships, workspaces, user } from "@/infra/db/schema";

/** Test-only: build a scope WITHOUT the membership check, to simulate a buggy/forged caller. */
export const forgeScope = (userId: string, workspaceId: string, role: Role = "owner"): TenantScope =>
  Object.freeze({ userId, workspaceId, role }) as unknown as TenantScope;

export async function makeUser(label = "u"): Promise<string> {
  const id = randomUUID();
  await withSystem((tx) =>
    tx.insert(user).values({ id, name: label, email: `${label}-${id}@test.local` }),
  );
  return id;
}

export async function makeWorkspace(ownerId: string, name = "WS"): Promise<string> {
  return withUser(ownerId, async (tx) => {
    const [w] = await tx
      .insert(workspaces)
      .values({ name, slug: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`, ownerId })
      .returning({ id: workspaces.id });
    await tx.insert(memberships).values({ workspaceId: w!.id, userId: ownerId, role: "owner" });
    return w!.id;
  });
}

/** Deterministic pseudo-embedding: unit vector concentrated on one axis. Distinct axes ⇒ orthogonal ⇒ predictable ranking. */
export function axisVector(axis: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  v[axis % EMBEDDING_DIMENSIONS] = 1;
  return v;
}
export const vecLiteral = (v: number[]) => `[${v.join(",")}]`;

export async function addDoc(
  scope: TenantScope,
  opts: { title?: string; text: string; axis: number; flagged?: boolean },
): Promise<{ documentId: string; chunkId: string }> {
  return withTenant(scope, async (tx: Tx) => {
    const [d] = await tx
      .insert(documents)
      .values({
        workspaceId: scope.workspaceId,
        title: opts.title ?? "Doc",
        filename: "doc.txt",
        mime: "text/plain",
        sizeBytes: opts.text.length,
        contentHash: randomUUID(),
        status: "ready",
        chunkCount: 1,
        createdBy: scope.userId,
      })
      .returning({ id: documents.id });
    const [c] = await tx
      .insert(chunks)
      .values({
        workspaceId: scope.workspaceId,
        documentId: d!.id,
        ordinal: 0,
        content: opts.text,
        tokenCount: Math.ceil(opts.text.length / 4),
        embedding: axisVector(opts.axis),
        embeddingModel: "test",
        flagged: opts.flagged ?? false,
      })
      .returning({ id: chunks.id });
    return { documentId: d!.id, chunkId: c!.id };
  });
}

export const count = async (tx: Tx, table: string): Promise<number> => {
  const r = await tx.execute<{ n: string }>(sql.raw(`SELECT count(*)::text AS n FROM ${table}`));
  return Number(r.rows[0]!.n);
};
