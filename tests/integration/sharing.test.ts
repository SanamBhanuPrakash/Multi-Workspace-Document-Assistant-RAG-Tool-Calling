import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { askQuestion } from "@/core/application/ask";
import { registerDocument, processIngestion } from "@/core/application/ingest";
import type { RetrievalParams } from "@/core/domain/types";
import type { TenantScope } from "@/core/security/tenant";
import { closePool, withSystem } from "@/infra/db/client";
import { FakeEmbedding } from "@/infra/embed/fake";
import { chunkStore, documentRepo, shareRepo } from "@/infra/db/repositories";
import { forgeScope, makeUser, makeWorkspace } from "../helpers/db";
import { doc, realIngestDeps, scopeFor } from "../helpers/deps";
import { doneOf, drain, makeAskDeps, ScriptedLlm, say } from "../helpers/ask";

afterAll(() => closePool());

const PARAMS: RetrievalParams = { k: 6, candidatePool: 30, rrfK: 60, minSimilarity: 0.2 };
const embedder = new FakeEmbedding();
const search = async (scope: TenantScope, q: string) => {
  const [embedding] = await embedder.embed([q], "query");
  return chunkStore.hybridSearch(scope, { embedding: embedding!, text: q, params: PARAMS });
};
const ingest = async (scope: TenantScope, title: string, text: string) => {
  const d = realIngestDeps();
  const r = await registerDocument(d, scope, doc(title, text));
  await processIngestion(d, scope, r.document.id);
  return r.document;
};
const shareRows = async (docId: string) =>
  Number((await withSystem((tx) => tx.execute<{ n: string }>(sql`SELECT count(*)::text n FROM document_shares WHERE document_id = ${docId}::uuid`))).rows[0]!.n);

const SHARED = "# Field Manual\n\n## Habitat\nThe marmoset colony code is MARMOSET-2210 and the enclosure key rotates monthly.\n";
const PRIVATE_A = "# Ledger\n\n## Vault\nThe strongbox combination is QUOKKA-9134 and is never shared with anyone.\n";
const OWN_B = "# Beta Notes\n\n## Tea\nThe office tea rota assigns kettle duty to whoever arrives first.\n";

describe("opt-in cross-workspace sharing", () => {
  let owner: string, stranger: string;
  let wsA: string, wsB: string, wsC: string, wsS: string;
  let A: TenantScope, B: TenantScope, C: TenantScope, S: TenantScope;
  let sharedDoc: { id: string }, bDoc: { id: string };

  beforeAll(async () => {
    owner = await makeUser("share-owner");
    stranger = await makeUser("share-stranger");
    wsA = await makeWorkspace(owner, "Share A");
    wsB = await makeWorkspace(owner, "Share B");
    wsC = await makeWorkspace(owner, "Share C"); // same owner, never granted anything
    wsS = await makeWorkspace(stranger, "Stranger");
    [A, B, C, S] = await Promise.all([scopeFor(owner, wsA), scopeFor(owner, wsB), scopeFor(owner, wsC), scopeFor(stranger, wsS)]);
    sharedDoc = await ingest(A, "Field Manual", SHARED);
    await ingest(A, "Ledger", PRIVATE_A);
    bDoc = await ingest(B, "Beta Notes", OWN_B);
  });

  it("CONTROL: with no share, nothing crosses — B cannot retrieve A's documents", async () => {
    const hits = await search(B, "marmoset colony code");
    expect(hits.some((h) => h.content.includes("MARMOSET"))).toBe(false);
    expect(await shareRows(sharedDoc.id)).toBe(0);
  });

  it("a granted document becomes retrievable in the target, marked as shared from its source", async () => {
    await shareRepo.grant(A, sharedDoc.id, wsB);
    const hits = await search(B, "marmoset colony code");
    const hit = hits.find((h) => h.content.includes("MARMOSET-2210"));
    expect(hit).toBeTruthy();
    expect(hit!.workspaceId).toBe(wsA);
    expect(hit!.sharedFrom).not.toBeNull();
    expect(await shareRepo.outgoing(A)).toEqual([{ documentId: sharedDoc.id, targetWorkspaceId: wsB }]);
  });

  it("sharing is per-document: A's other document stays invisible to B", async () => {
    const hits = await search(B, "strongbox combination QUOKKA");
    expect(hits.some((h) => h.content.includes("QUOKKA"))).toBe(false);
  });

  it("sharing is one-way: A does not gain B's documents", async () => {
    const hits = await search(A, "office tea rota kettle duty");
    expect(hits.some((h) => h.content.includes("kettle"))).toBe(false);
  });

  it("sharing is not transitive and not global: same-owner C and a stranger's workspace see nothing", async () => {
    for (const scope of [C, S]) {
      const hits = await search(scope, "marmoset colony code MARMOSET-2210");
      expect(hits.some((h) => h.content.includes("MARMOSET"))).toBe(false);
    }
  });

  it("the source's own retrieval is unchanged (same document, still its own, not marked shared)", async () => {
    const hit = (await search(A, "marmoset colony code")).find((h) => h.content.includes("MARMOSET-2210"));
    expect(hit).toBeTruthy();
    expect(hit!.sharedFrom).toBeNull();
  });

  it("END-TO-END: the assistant in B answers from the shared document and cites it; the private one is still refused", async () => {
    const llm = new ScriptedLlm(() => say("STATUS: ANSWERED\n\nThe colony code is MARMOSET-2210 [1]."));
    const shared = doneOf(await drain(askQuestion(makeAskDeps(llm), B, { text: "What is the marmoset colony code?", clientRequestId: `share-e2e-${Math.random()}` })))!;
    expect(shared.abstained).toBe(false);
    expect(shared.citations).toHaveLength(1);

    const llm2 = new ScriptedLlm(() => say("STATUS: ANSWERED\n\nIt is QUOKKA-9134 [1]."));
    const priv = doneOf(await drain(askQuestion(makeAskDeps(llm2), B, { text: "What is the strongbox combination QUOKKA?", clientRequestId: `share-e2e-${Math.random()}` })))!;
    expect(priv.abstained).toBe(true);
    expect(llm2.answerCalls.every((c) => !JSON.stringify(c).includes("QUOKKA-9134"))).toBe(true); // the model never saw it
  });

  it("revoking removes access immediately", async () => {
    await shareRepo.revoke(A, sharedDoc.id, wsB);
    const hits = await search(B, "marmoset colony code MARMOSET-2210");
    expect(hits.some((h) => h.content.includes("MARMOSET"))).toBe(false);
    expect(await shareRows(sharedDoc.id)).toBe(0);
  });

  it("only owners/admins can grant or revoke", async () => {
    for (const role of ["member", "viewer"] as const) {
      await expect(shareRepo.grant(forgeScope(owner, wsA, role), sharedDoc.id, wsB)).rejects.toThrow("forbidden");
      await expect(shareRepo.revoke(forgeScope(owner, wsA, role), sharedDoc.id, wsB)).rejects.toThrow("forbidden");
    }
    expect(await shareRows(sharedDoc.id)).toBe(0);
  });

  it("you cannot share INTO a workspace you are not a member of (RLS refuses; nothing is written)", async () => {
    await expect(shareRepo.grant(A, sharedDoc.id, wsS)).rejects.toThrow();
    expect(await shareRows(sharedDoc.id)).toBe(0);
    const hits = await search(S, "marmoset colony code MARMOSET-2210");
    expect(hits.some((h) => h.content.includes("MARMOSET"))).toBe(false);
  });

  it("you cannot share a document you do not own by forging its id under your own scope", async () => {
    // bDoc lives in B; try to push it into C while acting as A.
    await expect(shareRepo.grant(A, bDoc.id, wsC)).rejects.toThrow("not_found");
    expect(await shareRows(bDoc.id)).toBe(0);
  });

  it("granting twice is idempotent", async () => {
    await shareRepo.grant(A, sharedDoc.id, wsB);
    await shareRepo.grant(A, sharedDoc.id, wsB);
    expect(await shareRows(sharedDoc.id)).toBe(1);
    await shareRepo.revoke(A, sharedDoc.id, wsB);
  });

  it("deleting the source document removes its shares and its chunks from the target", async () => {
    const tmp = await ingest(A, "Temp Share", "# Temp\n\n## Note\nThe walrus passphrase is WALRUS-7788 for this sprint only.\n");
    await shareRepo.grant(A, tmp.id, wsB);
    expect((await search(B, "walrus passphrase")).some((h) => h.content.includes("WALRUS-7788"))).toBe(true);
    await documentRepo.delete(A, tmp.id);
    expect(await shareRows(tmp.id)).toBe(0);
    expect((await search(B, "walrus passphrase")).some((h) => h.content.includes("WALRUS-7788"))).toBe(false);
  });
});
