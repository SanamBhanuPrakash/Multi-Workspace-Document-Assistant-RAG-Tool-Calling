import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { TenantScope } from "@/core/security/tenant";
import type { ConversationSummary, MessageDTO, ObservabilitySummary, RetrievalEventDTO, RetrievalParams, WorkspaceDTO } from "@/core/domain/types";
import { withTenant, withUser } from "./client";
import * as t from "./schema";

/** Read-side queries for the dashboard. Every one runs inside withTenant/withUser (RLS-subject role). */

const PALETTE = ["#5b8def", "#22c1a4", "#f2a541", "#e0607e", "#9b7bea", "#4cc3f0", "#8bc34a", "#ff8a5b"];

const slugify = (s: string): string =>
  s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";

export const workspaceRepo = {
  async listForUser(userId: string): Promise<WorkspaceDTO[]> {
    return withUser(userId, async (tx) => {
      const rows = await tx
        .select({ id: t.workspaces.id, name: t.workspaces.name, slug: t.workspaces.slug, color: t.workspaces.color, role: t.memberships.role })
        .from(t.memberships)
        .innerJoin(t.workspaces, eq(t.workspaces.id, t.memberships.workspaceId))
        .where(eq(t.memberships.userId, userId))
        .orderBy(t.workspaces.createdAt);
      return rows;
    });
  },

  /**
   * First-visit bootstrap. The /app page can render twice at once (prefetch + navigation); both would see "no workspaces" and
   * both would insert. A per-user advisory lock serialises them, and the count is re-checked INSIDE the lock, so exactly one wins.
   */
  async ensureFirst(userId: string, name = "My workspace"): Promise<WorkspaceDTO[]> {
    return withUser(userId, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ws-create:${userId}`}, 0))`);
      const rows = await tx
        .select({ id: t.workspaces.id, name: t.workspaces.name, slug: t.workspaces.slug, color: t.workspaces.color, role: t.memberships.role })
        .from(t.memberships)
        .innerJoin(t.workspaces, eq(t.workspaces.id, t.memberships.workspaceId))
        .where(eq(t.memberships.userId, userId))
        .orderBy(t.workspaces.createdAt);
      if (rows.length) return rows;
      const [w] = await tx.insert(t.workspaces).values({ name, slug: slugify(name), color: PALETTE[0]!, ownerId: userId }).returning();
      await tx.insert(t.memberships).values({ workspaceId: w!.id, userId, role: "owner" });
      await tx.insert(t.auditLog).values({ workspaceId: null, userId, action: "workspace.create", targetType: "workspace", targetId: w!.id });
      return [{ id: w!.id, name: w!.name, slug: w!.slug, color: w!.color, role: "owner" }];
    });
  },

  async create(userId: string, name: string): Promise<WorkspaceDTO> {
    const clean = name.trim().replace(/\s+/g, " ").slice(0, 80);
    return withUser(userId, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ws-create:${userId}`}, 0))`); // serialise slug allocation per user
      const existing = await tx.select({ slug: t.workspaces.slug }).from(t.workspaces).where(eq(t.workspaces.ownerId, userId));
      const taken = new Set(existing.map((e) => e.slug));
      const base = slugify(clean);
      let slug = base;
      for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
      const color = PALETTE[existing.length % PALETTE.length]!;
      const [w] = await tx.insert(t.workspaces).values({ name: clean, slug, color, ownerId: userId }).returning();
      await tx.insert(t.memberships).values({ workspaceId: w!.id, userId, role: "owner" });
      await tx.insert(t.auditLog).values({ workspaceId: null, userId, action: "workspace.create", targetType: "workspace", targetId: w!.id });
      return { id: w!.id, name: w!.name, slug: w!.slug, color: w!.color, role: "owner" };
    });
  },

  async get(scope: TenantScope): Promise<WorkspaceDTO | null> {
    return withTenant(scope, async (tx) => {
      const rows = await tx
        .select({ id: t.workspaces.id, name: t.workspaces.name, slug: t.workspaces.slug, color: t.workspaces.color })
        .from(t.workspaces)
        .where(eq(t.workspaces.id, scope.workspaceId))
        .limit(1);
      return rows[0] ? { ...rows[0], role: scope.role } : null;
    });
  },

  async rename(scope: TenantScope, name: string): Promise<void> {
    if (scope.role !== "owner") return;
    await withTenant(scope, async (tx) => {
      await tx.update(t.workspaces).set({ name: name.trim().slice(0, 80) }).where(eq(t.workspaces.id, scope.workspaceId));
    });
  },

  async remove(scope: TenantScope): Promise<boolean> {
    if (scope.role !== "owner") return false;
    return withTenant(scope, async (tx) => {
      await tx.insert(t.auditLog).values({ workspaceId: null, userId: scope.userId, action: "workspace.delete", targetType: "workspace", targetId: scope.workspaceId });
      const r = await tx.delete(t.workspaces).where(eq(t.workspaces.id, scope.workspaceId)).returning({ id: t.workspaces.id });
      return r.length > 0;
    });
  },
};

export const dashboardQueries = {
  async conversations(scope: TenantScope): Promise<ConversationSummary[]> {
    return withTenant(scope, async (tx) => {
      const rows = await tx
        .select({ id: t.conversations.id, title: t.conversations.title, updatedAt: t.conversations.updatedAt })
        .from(t.conversations)
        .where(and(eq(t.conversations.workspaceId, scope.workspaceId), eq(t.conversations.userId, scope.userId)))
        .orderBy(desc(t.conversations.updatedAt))
        .limit(50);
      return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() }));
    });
  },

  async messages(scope: TenantScope, conversationId: string): Promise<MessageDTO[]> {
    return withTenant(scope, async (tx) => {
      const own = await tx
        .select({ id: t.conversations.id })
        .from(t.conversations)
        .where(and(eq(t.conversations.id, conversationId), eq(t.conversations.workspaceId, scope.workspaceId), eq(t.conversations.userId, scope.userId)))
        .limit(1);
      if (!own[0]) return [];
      const rows = await tx.select().from(t.messages).where(eq(t.messages.conversationId, conversationId)).orderBy(t.messages.seq).limit(300);
      const staleMs = 2 * 60_000;
      return rows.map((r) => {
        const stalled = r.status === "pending" && Date.now() - r.createdAt.getTime() > staleMs;
        return {
          id: r.id, conversationId: r.conversationId, role: r.role as MessageDTO["role"], content: r.content,
          status: (stalled ? "failed" : r.status) as MessageDTO["status"], errorCode: stalled ? "stalled" : r.errorCode,
          citations: r.citations, abstained: r.abstained, createdAt: r.createdAt.toISOString(),
        };
      });
    });
  },

  async toolCallsForMessages(scope: TenantScope, messageIds: string[]) {
    if (!messageIds.length) return [];
    return withTenant(scope, async (tx) => {
      const rows = await tx
        .select()
        .from(t.toolCalls)
        .where(and(eq(t.toolCalls.workspaceId, scope.workspaceId), inArray(t.toolCalls.messageId, messageIds)))
        .orderBy(t.toolCalls.createdAt);
      return rows.map((r) => ({ id: r.id, messageId: r.messageId, step: r.step, toolName: r.toolName, status: r.status, errorCode: r.errorCode, errorMessage: r.errorMessage, latencyMs: r.latencyMs, tainted: r.tainted, validatedArgs: r.validatedArgs, result: r.result }));
    });
  },

  async retrievalForMessage(scope: TenantScope, messageId: string): Promise<RetrievalEventDTO | null> {
    return withTenant(scope, async (tx) => {
      const rows = await tx
        .select()
        .from(t.retrievalEvents)
        .where(and(eq(t.retrievalEvents.workspaceId, scope.workspaceId), eq(t.retrievalEvents.messageId, messageId)))
        .orderBy(desc(t.retrievalEvents.createdAt))
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id, messageId: r.messageId, query: r.query, standaloneQuery: r.standaloneQuery, hit: r.hit, topSimilarity: r.topSimilarity,
        latencyMs: r.latencyMs, createdAt: r.createdAt.toISOString(), workspaceId: r.workspaceId, params: r.params as RetrievalParams, results: r.results,
      };
    });
  },

  async recentRetrievals(scope: TenantScope, limit = 20): Promise<RetrievalEventDTO[]> {
    return withTenant(scope, async (tx) => {
      const rows = await tx.select().from(t.retrievalEvents).where(eq(t.retrievalEvents.workspaceId, scope.workspaceId)).orderBy(desc(t.retrievalEvents.createdAt)).limit(limit);
      return rows.map((r) => ({
        id: r.id, messageId: r.messageId, query: r.query, standaloneQuery: r.standaloneQuery, hit: r.hit, topSimilarity: r.topSimilarity,
        latencyMs: r.latencyMs, createdAt: r.createdAt.toISOString(), workspaceId: r.workspaceId, params: r.params as RetrievalParams, results: r.results,
      }));
    });
  },

  async tasks(scope: TenantScope) {
    return withTenant(scope, async (tx) => {
      const rows = await tx.select().from(t.tasks).where(eq(t.tasks.workspaceId, scope.workspaceId)).orderBy(desc(t.tasks.createdAt)).limit(100);
      return rows.map((r) => ({ id: r.id, title: r.title, description: r.description, priority: r.priority as "low" | "normal" | "high", dueDate: r.dueDate, status: r.status as "open" | "done", createdAt: r.createdAt.toISOString() }));
    });
  },

  async setTaskStatus(scope: TenantScope, taskId: string, status: "open" | "done"): Promise<void> {
    await withTenant(scope, async (tx) => {
      await tx.update(t.tasks).set({ status }).where(and(eq(t.tasks.id, taskId), eq(t.tasks.workspaceId, scope.workspaceId)));
    });
  },

  /** Per-workspace metrics. Percentiles are computed in SQL; nothing here leaves the tenant boundary (RLS + explicit predicate). */
  async observability(scope: TenantScope, windowHours = 24): Promise<ObservabilitySummary> {
    return withTenant(scope, async (tx) => {
      const ws = scope.workspaceId;
      const since = sql`now() - (${windowHours}::int * interval '1 hour')`;
      const totals = await tx.execute<{
        requests: string; errors: string; abstained: string; hit_rate: number | null;
        p50: number | null; p95: number | null; avg: number | null; ttft: number | null; tin: string; tout: string;
      }>(sql`
        SELECT count(*)::text AS requests,
               count(*) FILTER (WHERE status = 'error')::text AS errors,
               count(*) FILTER (WHERE status = 'abstained')::text AS abstained,
               (avg((retrieval_hit)::int) FILTER (WHERE retrieval_hit IS NOT NULL))::float8 AS hit_rate,
               (percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms))::float8 AS p50,
               (percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms))::float8 AS p95,
               (avg(latency_ms))::float8 AS avg,
               (percentile_cont(0.5) WITHIN GROUP (ORDER BY first_token_ms))::float8 AS ttft,
               COALESCE(sum(tokens_in), 0)::text AS tin, COALESCE(sum(tokens_out), 0)::text AS tout
        FROM request_traces WHERE workspace_id = ${ws}::uuid AND kind = 'chat' AND created_at >= ${since}`);
      const byProvider = await tx.execute<{ provider: string; model: string; n: string; tin: string; tout: string }>(sql`
        SELECT COALESCE(provider, 'unknown') AS provider, COALESCE(model, '') AS model, count(*)::text AS n,
               COALESCE(sum(tokens_in), 0)::text AS tin, COALESCE(sum(tokens_out), 0)::text AS tout
        FROM request_traces WHERE workspace_id = ${ws}::uuid AND kind = 'chat' AND created_at >= ${since}
        GROUP BY 1, 2 ORDER BY count(*) DESC`);
      const tools = await tx.execute<{ name: string; status: string; n: string }>(sql`
        SELECT tool_name AS name, status, count(*)::text AS n FROM tool_calls
        WHERE workspace_id = ${ws}::uuid AND created_at >= ${since} GROUP BY 1, 2 ORDER BY 1, 2`);
      const ingestion = await tx.execute<{ status: string; n: string }>(sql`
        SELECT status, count(*)::text AS n FROM documents WHERE workspace_id = ${ws}::uuid GROUP BY status`);
      const hourly = await tx.execute<{ hour: string; n: string; errs: string; p95: number | null }>(sql`
        SELECT to_char(date_trunc('hour', created_at), 'YYYY-MM-DD"T"HH24:00:00"Z"') AS hour, count(*)::text AS n,
               count(*) FILTER (WHERE status = 'error')::text AS errs,
               (percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms))::float8 AS p95
        FROM request_traces WHERE workspace_id = ${ws}::uuid AND kind = 'chat' AND created_at >= ${since}
        GROUP BY 1 ORDER BY 1`);
      const tr = totals.rows[0]!;
      const ing = Object.fromEntries(ingestion.rows.map((r) => [r.status, Number(r.n)]));
      return {
        windowHours,
        requests: Number(tr.requests), errors: Number(tr.errors), abstained: Number(tr.abstained), retrievalHitRate: tr.hit_rate,
        latencyMs: { p50: tr.p50, p95: tr.p95, avg: tr.avg }, firstTokenMs: { p50: tr.ttft },
        tokensIn: Number(tr.tin), tokensOut: Number(tr.tout),
        byProvider: byProvider.rows.map((r) => ({ provider: r.provider, model: r.model, requests: Number(r.n), tokensIn: Number(r.tin), tokensOut: Number(r.tout) })),
        tools: tools.rows.map((r) => ({ name: r.name, status: r.status, count: Number(r.n) })),
        ingestion: { ready: ing.ready ?? 0, failed: ing.failed ?? 0, processing: (ing.processing ?? 0) + (ing.queued ?? 0) },
        hourly: hourly.rows.map((r) => ({ hour: r.hour, requests: Number(r.n), errors: Number(r.errs), p95Ms: r.p95 })),
      };
    });
  },
};
