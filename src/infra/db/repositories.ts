import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import type { MembershipLookup, Role } from "@/core/security/tenant";
import { validateWebhookUrl, webhookHint } from "@/core/security/webhook";
import type {
  ChunkStorePort,
  ConversationRepo,
  DocumentRepo,
  IngestionJobRepo,
  IntegrationRepo,
  NewChunk,
  ObservabilityRepo,
  RateLimiterPort,
  TaskRepo,
  ToolCallRepo,
} from "@/core/ports/repositories";
import type { DocumentDTO, MessageDTO, RetrievedChunk, TaskDTO, ToolCallDTO, ToolCallStatus } from "@/core/domain/types";
import { seal, open } from "../crypto/secretbox";
import { withSystem, withTenant, withUser, type Tx } from "./client";
import * as t from "./schema";

/* ───────────────────────────── helpers ───────────────────────────── */

/** Drizzle wraps driver errors; the Postgres SQLSTATE lives on the cause. */
export function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" ? code : undefined;
}

const iso = (d: Date | null): string => (d ?? new Date(0)).toISOString();

const toDoc = (r: typeof t.documents.$inferSelect, activeWorkspaceId: string): DocumentDTO => ({
  id: r.id,
  workspaceId: r.workspaceId,
  title: r.title,
  filename: r.filename,
  mime: r.mime,
  sizeBytes: r.sizeBytes,
  status: r.status as DocumentDTO["status"],
  error: r.error,
  chunkCount: r.chunkCount,
  flaggedChunkCount: r.flaggedChunkCount,
  createdAt: iso(r.createdAt),
  sharedFromWorkspaceId: r.workspaceId === activeWorkspaceId ? null : r.workspaceId,
});

const toMessage = (r: typeof t.messages.$inferSelect): MessageDTO => ({
  id: r.id,
  conversationId: r.conversationId,
  role: r.role as MessageDTO["role"],
  content: r.content,
  status: r.status as MessageDTO["status"],
  errorCode: r.errorCode,
  citations: r.citations,
  abstained: r.abstained,
  createdAt: iso(r.createdAt),
});

const toToolCall = (r: typeof t.toolCalls.$inferSelect): ToolCallDTO => ({
  id: r.id,
  messageId: r.messageId,
  step: r.step,
  toolName: r.toolName,
  rawArgs: r.rawArgs,
  validatedArgs: r.validatedArgs,
  status: r.status as ToolCallStatus,
  result: r.result,
  errorCode: r.errorCode,
  errorMessage: r.errorMessage,
  latencyMs: r.latencyMs,
  tainted: r.tainted,
  createdAt: iso(r.createdAt),
});

const toTask = (r: typeof t.tasks.$inferSelect): TaskDTO => ({
  id: r.id,
  title: r.title,
  description: r.description,
  priority: r.priority as TaskDTO["priority"],
  dueDate: r.dueDate,
  status: r.status as TaskDTO["status"],
  createdAt: iso(r.createdAt),
});

/* ───────────────────────────── membership ───────────────────────────── */

export const membershipLookup: MembershipLookup = {
  async roleOf(userId, workspaceId): Promise<Role | null> {
    return withUser(userId, async (tx) => {
      const rows = await tx
        .select({ role: t.memberships.role })
        .from(t.memberships)
        .where(and(eq(t.memberships.workspaceId, workspaceId), eq(t.memberships.userId, userId)))
        .limit(1);
      return (rows[0]?.role as Role | undefined) ?? null;
    });
  },
};

/* ───────────────────────────── documents ───────────────────────────── */

export const documentRepo: DocumentRepo = {
  async createIfAbsent(scope, input) {
    return withTenant(scope, async (tx) => {
      const inserted = await tx
        .insert(t.documents)
        .values({
          workspaceId: scope.workspaceId,
          title: input.title,
          filename: input.filename,
          mime: input.mime,
          sizeBytes: input.sizeBytes,
          contentHash: input.contentHash,
          createdBy: scope.userId,
        })
        .onConflictDoNothing({ target: [t.documents.workspaceId, t.documents.contentHash] })
        .returning();
      if (inserted[0]) {
        await tx.insert(t.documentSources).values({ documentId: inserted[0].id, workspaceId: scope.workspaceId, text: input.sourceText, hiddenCharCount: input.hiddenCharCount });
        return { document: toDoc(inserted[0], scope.workspaceId), created: true };
      }
      const existing = await tx
        .select()
        .from(t.documents)
        .where(and(eq(t.documents.workspaceId, scope.workspaceId), eq(t.documents.contentHash, input.contentHash)))
        .limit(1);
      return { document: toDoc(existing[0]!, scope.workspaceId), created: false };
    });
  },

  async get(scope, documentId) {
    return withTenant(scope, async (tx) => {
      const rows = await tx.select().from(t.documents).where(eq(t.documents.id, documentId)).limit(1);
      return rows[0] ? toDoc(rows[0], scope.workspaceId) : null;
    });
  },

  async list(scope) {
    return withTenant(scope, async (tx) => {
      const rows = await tx.select().from(t.documents).orderBy(desc(t.documents.createdAt));
      return rows.map((r) => toDoc(r, scope.workspaceId));
    });
  },

  async getSource(scope, documentId) {
    return withTenant(scope, async (tx) => {
      const rows = await tx
        .select({ text: t.documentSources.text, hiddenCharCount: t.documentSources.hiddenCharCount })
        .from(t.documentSources)
        .where(and(eq(t.documentSources.documentId, documentId), eq(t.documentSources.workspaceId, scope.workspaceId)))
        .limit(1);
      return rows[0] ?? null;
    });
  },

  async markStatus(scope, documentId, status, patch = {}) {
    await withTenant(scope, async (tx) => {
      await tx
        .update(t.documents)
        .set({
          status,
          updatedAt: new Date(),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(patch.chunkCount !== undefined ? { chunkCount: patch.chunkCount } : {}),
          ...(patch.flaggedChunkCount !== undefined ? { flaggedChunkCount: patch.flaggedChunkCount } : {}),
        })
        .where(and(eq(t.documents.id, documentId), eq(t.documents.workspaceId, scope.workspaceId)));
    });
  },

  async delete(scope, documentId) {
    return withTenant(scope, async (tx) => {
      const r = await tx
        .delete(t.documents)
        .where(and(eq(t.documents.id, documentId), eq(t.documents.workspaceId, scope.workspaceId)))
        .returning({ id: t.documents.id });
      return r.length > 0;
    });
  },
};

/* ───────────────────────────── chunks / hybrid retrieval ───────────────────────────── */

const vectorLiteral = (v: number[]): string => `[${v.join(",")}]`;

/** Above this many chunks visible to a workspace, retrieval switches from exact to ANN search (see hybridSearch). */
export const EXACT_SEARCH_MAX_CHUNKS = 50_000;

/**
 * Rows visible to the active workspace: its own chunks, plus chunks of documents EXPLICITLY shared into it.
 * This predicate is inlined into both retrieval branches below — filtering happens inside the query, not after it.
 */
const visibleChunk = (ws: string) => sql`(c.workspace_id = ${ws}::uuid OR c.document_id IN (
  SELECT ds.document_id FROM document_shares ds WHERE ds.target_workspace_id = ${ws}::uuid))`;

export const chunkStore: ChunkStorePort = {
  async upsertChunks(scope, documentId, embeddingModel, chunks: NewChunk[]) {
    if (!chunks.length) return;
    await withTenant(scope, async (tx) => {
      await tx
        .insert(t.chunks)
        .values(
          chunks.map((c) => ({
            workspaceId: scope.workspaceId, // ALWAYS from the verified scope, never from input
            documentId,
            ordinal: c.ordinal,
            headingPath: c.headingPath,
            content: c.content,
            tokenCount: c.tokenCount,
            embedding: c.embedding,
            embeddingModel,
            flagged: c.flagged,
            flagReasons: c.flagReasons,
          })),
        )
        .onConflictDoUpdate({
          target: [t.chunks.documentId, t.chunks.ordinal],
          set: {
            headingPath: sql`excluded.heading_path`,
            content: sql`excluded.content`,
            tokenCount: sql`excluded.token_count`,
            embedding: sql`excluded.embedding`,
            embeddingModel: sql`excluded.embedding_model`,
            flagged: sql`excluded.flagged`,
            flagReasons: sql`excluded.flag_reasons`,
          },
        });
    });
  },

  async countForDocument(scope, documentId) {
    return withTenant(scope, async (tx) => {
      const r = await tx.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM chunks WHERE document_id = ${documentId}::uuid AND workspace_id = ${scope.workspaceId}::uuid`,
      );
      return Number(r.rows[0]?.n ?? 0);
    });
  },

  async hybridSearch(scope, { embedding, text, params }) {
    const ws = scope.workspaceId;
    const qv = vectorLiteral(embedding);
    return withTenant(scope, async (tx) => {
      /*
       * Search mode. ANN (HNSW) is approximate and applies row filters AFTER the graph traversal, so for a small tenant
       * beside large neighbours it can miss rows entirely — outlier vectors may be unreachable in the graph, and no scan
       * setting fixes that. For tenancy-critical retrieval we therefore search EXACTLY within the workspace (btree on
       * workspace_id + sort: perfect recall, cost linear in the workspace's own size) and only fall back to ANN when the
       * workspace is large enough that an exact scan would be slow. `(dist) + 0` is what stops the planner from using HNSW.
       */
      const size = await tx.execute<{ n: string }>(sql`
        SELECT COALESCE(sum(d.chunk_count), 0)::text AS n FROM documents d
        WHERE d.status = 'ready' AND (d.workspace_id = ${ws}::uuid OR d.id IN (
          SELECT ds.document_id FROM document_shares ds WHERE ds.target_workspace_id = ${ws}::uuid))`);
      const exact = Number(size.rows[0]?.n ?? 0) <= EXACT_SEARCH_MAX_CHUNKS;
      const vecOrder = exact ? sql`(c.embedding <=> q.qv) + 0` : sql`c.embedding <=> q.qv`;

      const r = await tx.execute<{
        id: string; document_id: string; title: string; heading_path: string; ordinal: number; content: string;
        workspace_id: string; flagged: boolean; vr: string | null; kr: string | null; sim: number; kw: number | null; rrf: number;
      }>(sql`
        WITH q AS (SELECT ${qv}::vector AS qv, websearch_to_tsquery('english', ${text}) AS tq),
        -- Top-N first (ORDER BY + LIMIT), THEN rank: a window function before LIMIT would force a full scan.
        vec AS (
          SELECT s.id, ROW_NUMBER() OVER (ORDER BY s.ord) AS rnk FROM (
            SELECT c.id, ${vecOrder} AS ord
            FROM chunks c CROSS JOIN q
            WHERE ${visibleChunk(ws)}
            ORDER BY ${vecOrder}
            LIMIT ${params.candidatePool}
          ) s
        ),
        kw AS (
          SELECT s.id, s.score, ROW_NUMBER() OVER (ORDER BY s.score DESC) AS rnk FROM (
            SELECT c.id, ts_rank_cd(c.tsv, q.tq) AS score
            FROM chunks c CROSS JOIN q
            WHERE c.tsv @@ q.tq AND ${visibleChunk(ws)}
            ORDER BY score DESC
            LIMIT ${params.candidatePool}
          ) s
        ),
        fused AS (
          SELECT COALESCE(v.id, k.id) AS id, v.rnk AS vr, k.rnk AS kr, k.score AS kw,
                 COALESCE(1.0 / (${params.rrfK} + v.rnk), 0) + COALESCE(1.0 / (${params.rrfK} + k.rnk), 0) AS rrf
          FROM vec v FULL OUTER JOIN kw k ON k.id = v.id
        )
        SELECT c.id, c.document_id, d.title, c.heading_path, c.ordinal, c.content, c.workspace_id, c.flagged,
               f.vr::text AS vr, f.kr::text AS kr, f.kw, f.rrf::float8 AS rrf,
               (1 - (c.embedding <=> (SELECT qv FROM q)))::float8 AS sim
        FROM fused f
        JOIN chunks c ON c.id = f.id
        JOIN documents d ON d.id = c.document_id
        ORDER BY f.rrf DESC, sim DESC
        LIMIT ${params.k}`);

      return r.rows.map<RetrievedChunk>((row) => ({
        chunkId: row.id,
        documentId: row.document_id,
        documentTitle: row.title,
        headingPath: row.heading_path,
        ordinal: row.ordinal,
        content: row.content,
        workspaceId: row.workspace_id,
        sharedFrom: row.workspace_id === ws ? null : row.workspace_id,
        vectorRank: row.vr === null ? null : Number(row.vr),
        keywordRank: row.kr === null ? null : Number(row.kr),
        vectorSimilarity: Number(row.sim),
        keywordScore: row.kw === null ? null : Number(row.kw),
        rrfScore: Number(row.rrf),
        flagged: row.flagged,
      }));
    });
  },
};

/* ───────────────────────────── ingestion jobs ───────────────────────────── */

export const ingestionJobRepo: IngestionJobRepo = {
  async enqueue(scope, documentId) {
    await withTenant(scope, async (tx) => {
      await tx
        .insert(t.ingestionJobs)
        .values({ workspaceId: scope.workspaceId, documentId, requestedBy: scope.userId })
        .onConflictDoNothing({ target: t.ingestionJobs.documentId });
    });
  },

  async requeue(scope, documentId) {
    await withTenant(scope, async (tx) => {
      await tx
        .update(t.ingestionJobs)
        .set({ status: "queued", attempts: 0, lockedUntil: null, lastError: null, updatedAt: new Date() })
        .where(and(eq(t.ingestionJobs.documentId, documentId), eq(t.ingestionJobs.workspaceId, scope.workspaceId)));
    });
  },

  async claim(scope, documentId, leaseMs) {
    return withTenant(scope, async (tx) => {
      // Atomic lease: only one worker can move a job to `running` while its lease is unexpired.
      const r = await tx.execute<{ checkpoint: number; attempts: number }>(sql`
        UPDATE ingestion_jobs
           SET status = 'running', updated_at = now(),
               locked_until = now() + (${leaseMs}::int * interval '1 millisecond')
         WHERE document_id = ${documentId}::uuid AND workspace_id = ${scope.workspaceId}::uuid
           AND status IN ('queued', 'running', 'failed')
           AND (locked_until IS NULL OR locked_until < now())
           AND attempts < 5
        RETURNING checkpoint, attempts`);
      return r.rows[0] ?? null;
    });
  },

  async checkpoint(scope, documentId, nextOrdinal, opts = {}) {
    await withTenant(scope, async (tx) => {
      await tx
        .update(t.ingestionJobs)
        .set({ checkpoint: nextOrdinal, updatedAt: new Date(), lockedUntil: opts.release ? null : sql`now() + interval '60 seconds'` })
        .where(and(eq(t.ingestionJobs.documentId, documentId), eq(t.ingestionJobs.workspaceId, scope.workspaceId)));
    });
  },

  async finish(scope, documentId, outcome) {
    await withTenant(scope, async (tx) => {
      await tx
        .update(t.ingestionJobs)
        .set({
          status: outcome.ok ? "done" : "failed",
          attempts: outcome.ok ? sql`${t.ingestionJobs.attempts}` : sql`${t.ingestionJobs.attempts} + 1`,
          lastError: outcome.ok ? null : outcome.error,
          lockedUntil: null,
          updatedAt: new Date(),
        })
        .where(and(eq(t.ingestionJobs.documentId, documentId), eq(t.ingestionJobs.workspaceId, scope.workspaceId)));
    });
  },
};

/* ───────────────────────────── conversations & messages ───────────────────────────── */

export const conversationRepo: ConversationRepo = {
  async createConversation(scope, title) {
    return withTenant(scope, async (tx) => {
      const [c] = await tx
        .insert(t.conversations)
        .values({ workspaceId: scope.workspaceId, userId: scope.userId, title: title.slice(0, 80) || "New conversation" })
        .returning({ id: t.conversations.id });
      return c!.id;
    });
  },

  async conversationExists(scope, conversationId) {
    return withTenant(scope, async (tx) => {
      const rows = await tx
        .select({ id: t.conversations.id })
        .from(t.conversations)
        .where(and(eq(t.conversations.id, conversationId), eq(t.conversations.workspaceId, scope.workspaceId), eq(t.conversations.userId, scope.userId)))
        .limit(1);
      return rows.length > 0;
    });
  },

  async listConversations(scope) {
    return withTenant(scope, async (tx) => {
      const rows = await tx
        .select({ id: t.conversations.id, title: t.conversations.title, updatedAt: t.conversations.updatedAt })
        .from(t.conversations)
        .where(and(eq(t.conversations.workspaceId, scope.workspaceId), eq(t.conversations.userId, scope.userId)))
        .orderBy(desc(t.conversations.updatedAt))
        .limit(50);
      return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: iso(r.updatedAt) }));
    });
  },

  async beginTurn(scope, { conversationId, text, clientRequestId }) {
    const readExisting = (tx: Tx) =>
      tx
        .select()
        .from(t.messages)
        .where(and(eq(t.messages.conversationId, conversationId), eq(t.messages.clientRequestId, clientRequestId)))
        .limit(1);
    const pair = async (tx: Tx, user: typeof t.messages.$inferSelect) => {
      const a = await tx.select().from(t.messages).where(eq(t.messages.replyToId, user.id)).limit(1);
      return { userMessage: toMessage(user), assistantMessage: toMessage(a[0]!) };
    };

    try {
      return await withTenant(scope, async (tx) => {
        const prior = await readExisting(tx);
        if (prior[0]) return { ...(await pair(tx, prior[0])), created: false };

        // The user's question is committed BEFORE any provider call — a slow or failing LLM can never lose it.
        const [u] = await tx
          .insert(t.messages)
          .values({ conversationId, workspaceId: scope.workspaceId, role: "user", content: text, status: "complete", clientRequestId, completedAt: new Date() })
          .returning();
        const [a] = await tx
          .insert(t.messages)
          .values({ conversationId, workspaceId: scope.workspaceId, role: "assistant", content: "", status: "pending", replyToId: u!.id })
          .returning();
        await tx.update(t.conversations).set({ updatedAt: new Date() }).where(eq(t.conversations.id, conversationId));
        return { userMessage: toMessage(u!), assistantMessage: toMessage(a!), created: true };
      });
    } catch (err) {
      if (pgCode(err) !== "23505") throw err; // concurrent double-submit lost the race: return the winner's pair
      return withTenant(scope, async (tx) => {
        const prior = await readExisting(tx);
        return { ...(await pair(tx, prior[0]!)), created: false };
      });
    }
  },

  async history(scope, conversationId, limit) {
    return withTenant(scope, async (tx) => {
      const rows = await tx
        .select()
        .from(t.messages)
        .where(and(eq(t.messages.conversationId, conversationId), eq(t.messages.workspaceId, scope.workspaceId)))
        .orderBy(desc(t.messages.createdAt), desc(t.messages.id))
        .limit(limit);
      return rows.reverse().map(toMessage);
    });
  },

  async finishAssistant(scope, messageId, patch) {
    await withTenant(scope, async (tx) => {
      await tx
        .update(t.messages)
        .set({
          content: patch.content,
          status: patch.status,
          errorCode: patch.errorCode ?? null,
          citations: patch.citations ?? [],
          abstained: patch.abstained ?? false,
          completedAt: new Date(),
        })
        .where(and(eq(t.messages.id, messageId), eq(t.messages.workspaceId, scope.workspaceId), eq(t.messages.role, "assistant")));
    });
  },

  async getMessage(scope, messageId) {
    return withTenant(scope, async (tx) => {
      const rows = await tx.select().from(t.messages).where(and(eq(t.messages.id, messageId), eq(t.messages.workspaceId, scope.workspaceId))).limit(1);
      return rows[0] ? toMessage(rows[0]) : null;
    });
  },

  async reopenFailed(scope, assistantMessageId) {
    return withTenant(scope, async (tx) => {
      const [a] = await tx
        .update(t.messages)
        .set({ status: "pending", errorCode: null, content: "", citations: [], abstained: false, completedAt: null })
        .where(and(eq(t.messages.id, assistantMessageId), eq(t.messages.workspaceId, scope.workspaceId), eq(t.messages.role, "assistant"), eq(t.messages.status, "failed")))
        .returning();
      if (!a?.replyToId) return null;
      const [u] = await tx.select().from(t.messages).where(eq(t.messages.id, a.replyToId)).limit(1);
      return u ? { userMessage: toMessage(u), assistantMessage: toMessage(a) } : null;
    });
  },
};

/* ───────────────────────────── tool calls & tasks ───────────────────────────── */

export const toolCallRepo: ToolCallRepo = {
  async begin(scope, input) {
    return withTenant(scope, async (tx) => {
      const inserted = await tx
        .insert(t.toolCalls)
        .values({
          workspaceId: scope.workspaceId,
          messageId: input.messageId,
          step: input.step,
          toolName: input.toolName.slice(0, 200),
          rawArgs: input.rawArgs.slice(0, 20_000),
          validatedArgs: input.validatedArgs ?? null,
          status: input.status,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          idempotencyKey: input.idempotencyKey,
          tainted: input.tainted,
          finishedAt: input.status === "rejected" ? new Date() : null,
        })
        .onConflictDoNothing({ target: [t.toolCalls.workspaceId, t.toolCalls.idempotencyKey] })
        .returning();
      if (inserted[0]) return { call: toToolCall(inserted[0]), created: true };
      const existing = await tx
        .select()
        .from(t.toolCalls)
        .where(and(eq(t.toolCalls.workspaceId, scope.workspaceId), eq(t.toolCalls.idempotencyKey, input.idempotencyKey)))
        .limit(1);
      return { call: toToolCall(existing[0]!), created: false };
    });
  },

  async finish(scope, id, patch) {
    await withTenant(scope, async (tx) => {
      await tx
        .update(t.toolCalls)
        .set({
          status: patch.status,
          result: patch.result ?? null,
          errorCode: patch.errorCode ?? null,
          errorMessage: patch.errorMessage ?? null,
          latencyMs: patch.latencyMs ?? null,
          confirmedBy: patch.confirmedBy ?? null,
          finishedAt: patch.status === "running" ? null : new Date(),
        })
        .where(and(eq(t.toolCalls.id, id), eq(t.toolCalls.workspaceId, scope.workspaceId)));
    });
  },

  async get(scope, id) {
    return withTenant(scope, async (tx) => {
      const rows = await tx.select().from(t.toolCalls).where(and(eq(t.toolCalls.id, id), eq(t.toolCalls.workspaceId, scope.workspaceId))).limit(1);
      return rows[0] ? toToolCall(rows[0]) : null;
    });
  },

  async list(scope, limit) {
    return withTenant(scope, async (tx) => {
      const rows = await tx.select().from(t.toolCalls).where(eq(t.toolCalls.workspaceId, scope.workspaceId)).orderBy(desc(t.toolCalls.createdAt)).limit(limit);
      return rows.map(toToolCall);
    });
  },
};

export const taskRepo: TaskRepo = {
  async create(scope, input) {
    return withTenant(scope, async (tx) => {
      const [r] = await tx
        .insert(t.tasks)
        .values({
          workspaceId: scope.workspaceId, // from verified scope only
          title: input.title,
          description: input.description ?? null,
          priority: input.priority,
          dueDate: input.dueDate ?? null,
          createdByToolCallId: input.toolCallId ?? null,
          createdBy: scope.userId,
        })
        .returning();
      return toTask(r!);
    });
  },

  async list(scope, status, limit) {
    return withTenant(scope, async (tx) => {
      const where = status === "all" ? eq(t.tasks.workspaceId, scope.workspaceId) : and(eq(t.tasks.workspaceId, scope.workspaceId), eq(t.tasks.status, status));
      const rows = await tx.select().from(t.tasks).where(where).orderBy(desc(t.tasks.createdAt)).limit(limit);
      return rows.map(toTask);
    });
  },
};

/* ───────────────────────────── integrations (encrypted) ───────────────────────────── */

const aad = (ws: string, kind: string) => `${ws}:${kind}`;

export const integrationRepo: IntegrationRepo = {
  async getWebhookUrl(scope, kind) {
    const sealed = await withTenant(scope, async (tx) => {
      const rows = await tx
        .select({ c: t.workspaceIntegrations.secretCiphertext })
        .from(t.workspaceIntegrations)
        .where(and(eq(t.workspaceIntegrations.workspaceId, scope.workspaceId), eq(t.workspaceIntegrations.kind, kind)))
        .limit(1);
      return rows[0]?.c ?? null;
    });
    return sealed ? open(sealed, aad(scope.workspaceId, kind)) : null;
  },

  async save(scope, kind, webhookUrl) {
    const url = validateWebhookUrl(kind, webhookUrl);
    const hint = webhookHint(url);
    const secretCiphertext = seal(url, aad(scope.workspaceId, kind));
    await withTenant(scope, async (tx) => {
      await tx
        .insert(t.workspaceIntegrations)
        .values({ workspaceId: scope.workspaceId, kind, secretCiphertext, hint, createdBy: scope.userId })
        .onConflictDoUpdate({ target: [t.workspaceIntegrations.workspaceId, t.workspaceIntegrations.kind], set: { secretCiphertext, hint, createdBy: scope.userId } });
    });
    return { hint };
  },

  async list(scope) {
    return withTenant(scope, async (tx) => {
      const rows = await tx
        .select({ kind: t.workspaceIntegrations.kind, hint: t.workspaceIntegrations.hint })
        .from(t.workspaceIntegrations)
        .where(eq(t.workspaceIntegrations.workspaceId, scope.workspaceId));
      return rows.map((r) => ({ kind: r.kind as "slack" | "discord", hint: r.hint })); // ciphertext is never selected
    });
  },

  async remove(scope, kind) {
    await withTenant(scope, async (tx) => {
      await tx.delete(t.workspaceIntegrations).where(and(eq(t.workspaceIntegrations.workspaceId, scope.workspaceId), eq(t.workspaceIntegrations.kind, kind)));
    });
  },
};

/* ───────────────────────────── observability ───────────────────────────── */

export const observabilityRepo: ObservabilityRepo = {
  async recordRetrieval(scope, input) {
    await withTenant(scope, async (tx) => {
      await tx.insert(t.retrievalEvents).values({
        workspaceId: scope.workspaceId,
        messageId: input.messageId,
        query: input.query.slice(0, 2000),
        standaloneQuery: input.standaloneQuery.slice(0, 2000),
        hit: input.hit,
        topSimilarity: input.topSimilarity,
        results: input.results as never,
        params: input.params,
        latencyMs: input.latencyMs,
      });
    });
  },

  async recordTrace(scope, input) {
    await withTenant(scope, async (tx) => {
      await tx.insert(t.requestTraces).values({
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        messageId: input.messageId ?? null,
        kind: input.kind,
        provider: input.provider ?? null,
        model: input.model ?? null,
        tokensIn: input.usage?.tokensIn ?? 0,
        tokensOut: input.usage?.tokensOut ?? 0,
        latencyMs: Math.round(input.latencyMs),
        retrievalMs: input.retrievalMs === undefined ? null : Math.round(input.retrievalMs),
        firstTokenMs: input.firstTokenMs === undefined ? null : Math.round(input.firstTokenMs),
        retrievalHit: input.retrievalHit ?? null,
        status: input.status,
        errorCode: input.errorCode ?? null,
      });
    });
  },
};

/* ───────────────────────────── rate limiting ───────────────────────────── */

export const rateLimiter: RateLimiterPort = {
  async allow(key, limit, windowSeconds) {
    return withSystem(async (tx) => {
      const r = await tx.execute<{ count: number }>(sql`
        INSERT INTO rate_limits (key, window_start, count)
        VALUES (${key}, to_timestamp(floor(extract(epoch FROM now()) / ${windowSeconds}) * ${windowSeconds}), 1)
        ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
        RETURNING count`);
      if (Math.random() < 0.01) await tx.execute(sql`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
      return (r.rows[0]?.count ?? 1) <= limit;
    });
  },
};
