import { DomainError, ProviderError } from "../domain/errors";
import type { Citation, MessageDTO, RetrievalParams, RetrievedChunk, ToolCallStatus, Usage } from "../domain/types";
import type { EmbeddingPort, LlmMessage, LlmPort } from "../ports/providers";
import type { ChunkStorePort, ConversationRepo, ObservabilityRepo, RateLimiterPort } from "../ports/repositories";
import { buildContextBlock, newFenceNonce, QUESTION_MARKER, SYSTEM_PROMPT_RULES, type FencedSource } from "../security/fence";
import { normalizeCitations, parseStatusLine, validateCitations } from "../security/grounding";
import { canWrite, type TenantScope } from "../security/tenant";
import { executeToolCall, type ExecutorDeps } from "./tools/executor";

/* ───────────────────────────── contract ───────────────────────────── */

export type AskEvent =
  | { type: "turn"; conversationId: string; userMessageId: string; assistantMessageId: string; replay: boolean }
  | { type: "retrieval"; hit: boolean; tainted: boolean; sources: { n: number; documentTitle: string; headingPath: string; ordinal: number; flagged: boolean; similarity: number | null }[] }
  | { type: "token"; delta: string }
  | { type: "tool"; callId: string; name: string; status: ToolCallStatus; step: number; message?: string }
  | { type: "done"; message: { id: string; content: string; citations: Citation[]; abstained: boolean; status: "complete" } }
  | { type: "error"; code: string; message: string; retryable: boolean; assistantMessageId: string };

export type AskConfig = {
  k: number;
  candidatePool: number;
  rrfK: number;
  maxSteps: number;
  maxHistoryMessages: number;
  maxHistoryChars: number;
  maxQuestionChars: number;
  perUserPerMinute: number;
  perWorkspacePerMinute: number;
};

export const DEFAULT_ASK_CONFIG: AskConfig = {
  k: 6,
  candidatePool: 30,
  rrfK: 60,
  maxSteps: 4,
  maxHistoryMessages: 6,
  maxHistoryChars: 6_000,
  maxQuestionChars: 4_000,
  perUserPerMinute: 20,
  perWorkspacePerMinute: 60,
};

export type AskDeps = {
  conv: ConversationRepo;
  chunks: ChunkStorePort;
  obs: ObservabilityRepo;
  embedder: EmbeddingPort;
  llm: LlmPort;
  limiter: RateLimiterPort;
  tools: ExecutorDeps;
  config?: Partial<AskConfig>;
  now?: () => number;
  newNonce?: () => string;
  log?: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
};

export const REFUSAL_NO_DOCS = "I don't know — this workspace's documents don't contain an answer to that. Try rephrasing, or upload a document that covers it.";
export const REFUSAL_UNGROUNDED = "I couldn't ground an answer to that in this workspace's documents, so I won't guess. Try rephrasing or upload a document that covers it.";

/* ───────────────────────────── retrieval ───────────────────────────── */

export type Retrieval = { candidates: RetrievedChunk[]; usable: RetrievedChunk[]; hit: boolean; topSimilarity: number | null; params: RetrievalParams; ms: number };

const paramsFor = (embedder: EmbeddingPort, cfg: AskConfig, k = cfg.k): RetrievalParams => ({ k, candidatePool: cfg.candidatePool, rrfK: cfg.rrfK, minSimilarity: embedder.minRelevance });

/**
 * A chunk is "usable evidence" when it is semantically close enough (per-embedding-model calibrated threshold), or it matched
 * the query lexically AND is at least moderately close. Similarity is computed for EVERY candidate, so a keyword-only hit
 * that is semantically unrelated (a common word) does not count.
 */
export function selectUsable(candidates: RetrievedChunk[], minRelevance: number): RetrievedChunk[] {
  return candidates.filter((c) => {
    const sim = c.vectorSimilarity ?? 0;
    return sim >= minRelevance || (c.keywordRank !== null && sim >= minRelevance - 0.1);
  });
}

export async function retrieve(deps: Pick<AskDeps, "chunks" | "embedder">, scope: TenantScope, query: string, cfg: AskConfig, k = cfg.k, now = Date.now): Promise<Retrieval> {
  const t0 = now();
  const [embedding] = await deps.embedder.embed([query], "query");
  const params = paramsFor(deps.embedder, cfg, k);
  const candidates = await deps.chunks.hybridSearch(scope, { embedding: embedding!, text: query, params });
  const usable = selectUsable(candidates, deps.embedder.minRelevance).slice(0, k);
  const top = candidates.reduce<number | null>((m, c) => (c.vectorSimilarity !== null && (m === null || c.vectorSimilarity > m) ? c.vectorSimilarity : m), null);
  return { candidates, usable, hit: usable.length > 0, topSimilarity: top, params, ms: now() - t0 };
}

/** Adapter for the search_documents tool: retrieval is workspace-scoped by the executor-supplied scope. */
export const makeRetriever = (deps: Pick<AskDeps, "chunks" | "embedder" | "config">) => async (scope: TenantScope, query: string, limit: number): Promise<RetrievedChunk[]> =>
  (await retrieve(deps, scope, query, { ...DEFAULT_ASK_CONFIG, ...deps.config }, limit)).usable;

/* ───────────────────────────── helpers ───────────────────────────── */

const stripCitations = (s: string): string => s.replace(/\s?\[\d{1,3}\]/g, "");

const toFenced = (chunks: RetrievedChunk[], startAt = 1): FencedSource[] =>
  chunks.map((c, i) => ({ n: startAt + i, title: c.documentTitle, section: c.headingPath, text: c.content }));

const snippet = (t: string): string => t.replace(/\s+/g, " ").trim().slice(0, 240);

function buildHistory(messages: MessageDTO[], cfg: AskConfig): LlmMessage[] {
  const out: LlmMessage[] = [];
  let budget = cfg.maxHistoryChars;
  for (const m of [...messages].reverse()) {
    if (m.status !== "complete" || !m.content.trim()) continue;
    // Old citation numbers refer to a previous turn's sources; keeping them would let the model mis-cite.
    const text = (m.role === "assistant" ? stripCitations(m.content) : m.content).slice(0, 1500);
    if (text.length > budget) break;
    budget -= text.length;
    out.unshift(m.role === "user" ? { role: "user", text } : { role: "assistant", text });
    if (out.length >= cfg.maxHistoryMessages) break;
  }
  while (out[0]?.role === "assistant") out.shift(); // providers require the first turn to be the user's
  return out;
}

async function collect(llm: LlmPort, req: Parameters<LlmPort["generate"]>[0], signal?: AbortSignal): Promise<{ text: string; usage: Usage }> {
  let text = "";
  let usage: Usage = { tokensIn: 0, tokensOut: 0 };
  for await (const ev of llm.generate(req, signal)) {
    if (ev.type === "text") text += ev.delta;
    else if (ev.type === "usage") usage = ev.usage;
  }
  return { text, usage };
}

/** Follow-up → standalone search query. Sees ONLY the conversation (never document text). Any failure falls back to the raw question. */
async function condense(deps: AskDeps, history: LlmMessage[], question: string, signal?: AbortSignal): Promise<{ query: string; usage: Usage }> {
  if (history.length === 0) return { query: question, usage: { tokensIn: 0, tokensOut: 0 } };
  try {
    const { text, usage } = await collect(
      deps.llm,
      {
        system: "Rewrite the user's latest message as one standalone search query that makes sense without the conversation. Resolve pronouns and references. Output ONLY the query, no quotes, no explanation.",
        messages: [...history, { role: "user", text: question }],
        tools: [],
        temperature: 0,
        maxOutputTokens: 120,
      },
      signal,
    );
    const q = text.trim().replace(/^["'`]+|["'`]+$/g, "").split("\n")[0]!.trim();
    // A rewrite that is our own answer-protocol line (a model that ignored the instruction) is not a query: search the raw question.
    const plausible = q.length >= 2 && q.length <= 400 && !/^STATUS:/i.test(q);
    return { query: plausible ? q : question, usage };
  } catch {
    return { query: question, usage: { tokensIn: 0, tokensOut: 0 } };
  }
}

/** Splits the leading `STATUS:` protocol line off a token stream so the user never sees it, without delaying normal text. */
class StatusStripper {
  private buf = "";
  private decided = false;
  push(delta: string): string {
    if (this.decided) return delta;
    this.buf += delta;
    if (/^\s*STATUS:/i.test(this.buf)) {
      const nl = this.buf.indexOf("\n");
      if (nl === -1 && this.buf.length < 60) return "";
      this.decided = true;
      const rest = nl === -1 ? "" : this.buf.slice(nl + 1).replace(/^\n+/, "");
      this.buf = "";
      return rest;
    }
    if (this.buf.length < 8 && "STATUS:".startsWith(this.buf.trim().toUpperCase())) return ""; // could still become STATUS:
    this.decided = true;
    const out = this.buf;
    this.buf = "";
    return out;
  }
  flush(): string {
    if (this.decided) return "";
    this.decided = true;
    const out = /^\s*STATUS:/i.test(this.buf) ? "" : this.buf;
    this.buf = "";
    return out;
  }
}

const mapError = (err: unknown): { code: string; message: string; retryable: boolean } => {
  if (err instanceof DomainError) return { code: err.code, message: err.message, retryable: err.code === "rate_limited" };
  if (err instanceof ProviderError) return { code: err.code, message: err.message, retryable: err.retryable };
  return { code: "internal", message: "Something went wrong while answering. Your question was saved — you can retry.", retryable: true };
};

/* ───────────────────────────── public API ───────────────────────────── */

export type AskInput = { conversationId?: string | undefined; text: string; clientRequestId: string; signal?: AbortSignal | undefined };

/**
 * One chat turn as an event stream. Durability contract: the user's message AND a `pending` assistant row are committed
 * before any provider is called, so nothing the user typed is ever lost — a failure flips the row to `failed` (retryable).
 */
export async function* askQuestion(deps: AskDeps, scope: TenantScope, input: AskInput): AsyncGenerator<AskEvent> {
  const cfg: AskConfig = { ...DEFAULT_ASK_CONFIG, ...deps.config };
  const text = input.text.trim();
  if (!canWrite(scope)) throw new DomainError("not_a_member", "Your role cannot ask questions in this workspace.", 403);
  if (text.length < 1) throw new DomainError("validation", "Type a question first.", 422);
  if (text.length > cfg.maxQuestionChars) throw new DomainError("payload_too_large", `Questions are limited to ${cfg.maxQuestionChars} characters.`, 413);
  if (!input.clientRequestId || input.clientRequestId.length > 100) throw new DomainError("validation", "Missing request id.", 422);

  // Refuse BEFORE persisting anything, so a throttled client keeps its draft.
  if (!(await deps.limiter.allow(`chat:u:${scope.userId}`, cfg.perUserPerMinute, 60)) || !(await deps.limiter.allow(`chat:w:${scope.workspaceId}`, cfg.perWorkspacePerMinute, 60))) {
    throw new DomainError("rate_limited", "You're sending messages too quickly. Wait a moment and try again.", 429);
  }

  let conversationId = input.conversationId;
  if (conversationId) {
    if (!(await deps.conv.conversationExists(scope, conversationId))) throw new DomainError("not_found", "Conversation not found.", 404);
  } else {
    conversationId = await deps.conv.createConversation(scope, text.slice(0, 60));
  }

  const turn = await deps.conv.beginTurn(scope, { conversationId, text, clientRequestId: input.clientRequestId });
  yield { type: "turn", conversationId, userMessageId: turn.userMessage.id, assistantMessageId: turn.assistantMessage.id, replay: !turn.created };

  if (!turn.created) {
    const a = turn.assistantMessage;
    if (a.status === "complete") {
      yield { type: "done", message: { id: a.id, content: a.content, citations: a.citations, abstained: a.abstained, status: "complete" } };
    } else if (a.status === "failed") {
      yield { type: "error", code: a.errorCode ?? "internal", message: "This answer failed earlier. You can retry it.", retryable: true, assistantMessageId: a.id };
    } else {
      yield { type: "error", code: "conflict", message: "This question is already being answered.", retryable: false, assistantMessageId: a.id };
    }
    return;
  }
  yield* runTurn(deps, cfg, scope, { conversationId, userMessage: turn.userMessage, assistantMessage: turn.assistantMessage, signal: input.signal });
}

/** Re-run a `failed` reply against the SAME user message (no duplicate question is created). */
export async function* retryAnswer(deps: AskDeps, scope: TenantScope, assistantMessageId: string, signal?: AbortSignal): AsyncGenerator<AskEvent> {
  const cfg: AskConfig = { ...DEFAULT_ASK_CONFIG, ...deps.config };
  if (!canWrite(scope)) throw new DomainError("not_a_member", "Your role cannot retry answers.", 403);
  if (!(await deps.limiter.allow(`chat:u:${scope.userId}`, cfg.perUserPerMinute, 60))) throw new DomainError("rate_limited", "Too many requests. Wait a moment.", 429);
  const reopened = await deps.conv.reopenFailed(scope, assistantMessageId);
  if (!reopened) throw new DomainError("conflict", "That answer is not in a retryable state.", 409);
  yield { type: "turn", conversationId: reopened.userMessage.conversationId, userMessageId: reopened.userMessage.id, assistantMessageId: reopened.assistantMessage.id, replay: false };
  yield* runTurn(deps, cfg, scope, { conversationId: reopened.userMessage.conversationId, userMessage: reopened.userMessage, assistantMessage: reopened.assistantMessage, signal });
}

/* ───────────────────────────── the pipeline ───────────────────────────── */

type TurnCtx = { conversationId: string; userMessage: MessageDTO; assistantMessage: MessageDTO; signal: AbortSignal | undefined };

async function* runTurn(deps: AskDeps, cfg: AskConfig, scope: TenantScope, ctx: TurnCtx): AsyncGenerator<AskEvent> {
  const now = deps.now ?? Date.now;
  const started = now();
  const messageId = ctx.assistantMessage.id;
  const question = ctx.userMessage.content;
  const log = deps.log ?? (() => undefined);
  const usage: Usage = { tokensIn: 0, tokensOut: 0 };
  const addUsage = (u: Usage) => {
    usage.tokensIn += u.tokensIn;
    usage.tokensOut += u.tokensOut;
  };
  let served = { provider: deps.llm.provider, model: deps.llm.model };
  let retrievalMs = 0;
  let firstTokenMs: number | undefined;
  let hit: boolean | undefined;
  let finalized = false; // set once the assistant row reaches a terminal state

  try {
    /* 1 ── history (workspace-scoped, this conversation only) and standalone query */
    const prior = (await deps.conv.history(scope, ctx.conversationId, cfg.maxHistoryMessages + 2)).filter((m) => m.id !== ctx.userMessage.id && m.id !== messageId);
    const history = buildHistory(prior, cfg);
    const condensed = await condense(deps, history, question, ctx.signal);
    addUsage(condensed.usage);

    /* 2 ── retrieve: workspace predicate lives inside the SQL; result re-checked below as defence in depth */
    const r = await retrieve(deps, scope, condensed.query, cfg, cfg.k, now);
    retrievalMs = r.ms;
    hit = r.hit;
    // Defence in depth: the store already filters by workspace; if it ever returned a foreign, unshared row, refuse loudly.
    for (const c of r.candidates) {
      if (c.workspaceId !== scope.workspaceId && c.sharedFrom === null) throw new Error("isolation invariant violated: foreign chunk returned");
    }

    const sources: RetrievedChunk[] = [...r.usable];
    const nonce = (deps.newNonce ?? newFenceNonce)();
    const tainted0 = sources.some((s) => s.flagged);

    await deps.obs.recordRetrieval(scope, {
      messageId,
      query: question,
      standaloneQuery: condensed.query,
      hit: r.hit,
      topSimilarity: r.topSimilarity,
      results: r.candidates.map((c) => ({
        chunkId: c.chunkId, documentId: c.documentId, documentTitle: c.documentTitle, headingPath: c.headingPath, ordinal: c.ordinal, workspaceId: c.workspaceId,
        sharedFrom: c.sharedFrom, vectorRank: c.vectorRank, keywordRank: c.keywordRank, vectorSimilarity: c.vectorSimilarity,
        keywordScore: c.keywordScore, rrfScore: c.rrfScore, flagged: c.flagged, usedInContext: r.usable.some((u) => u.chunkId === c.chunkId),
      })),
      params: r.params,
      latencyMs: r.ms,
    });
    yield {
      type: "retrieval", hit: r.hit, tainted: tainted0,
      sources: sources.map((s, i) => ({ n: i + 1, documentTitle: s.documentTitle, headingPath: s.headingPath, ordinal: s.ordinal, flagged: s.flagged, similarity: s.vectorSimilarity })),
    };

    /* 3 ── generate, with a bounded multi-step tool loop */
    const framing = r.hit
      ? buildContextBlock(toFenced(sources), nonce)
      : "(no documents in this workspace matched the question. Do NOT answer factual questions. If — and only if — the user's own message asks for an action, use a tool. Otherwise reply with STATUS: NOT_IN_DOCUMENTS.)";
    const messages: LlmMessage[] = [...history, { role: "user", text: `${framing}\n\n---\n${QUESTION_MARKER}\n${question}` }];
    const declarations = deps.tools.registry.declarations();
    const streamToUser = r.hit; // on a miss the model's free text is discarded, never shown: only tool actions may proceed
    let finalRaw = "";
    // "Action" tools (anything not citable) may support an uncited reply like "Saved your task". Citable tools
    // (search_documents) may not: whatever they retrieve must still be cited, or the answer is refused as ungrounded.
    let actionAttempted = false;
    let actionSucceeded = false;
    let steps = 0;
    let exhausted = true;

    for (; steps < cfg.maxSteps; steps++) {
      const last = steps === cfg.maxSteps - 1;
      const strip = new StatusStripper();
      let stepText = "";
      const calls: { id: string; name: string; rawArgs: string }[] = [];
      for await (const ev of deps.llm.generate({ system: SYSTEM_PROMPT_RULES, messages, tools: last ? [] : declarations }, ctx.signal)) {
        if (ev.type === "meta") served = { provider: ev.provider, model: ev.model };
        else if (ev.type === "text") {
          stepText += ev.delta;
          if (streamToUser) {
            const out = strip.push(ev.delta);
            if (out) {
              firstTokenMs ??= now() - started;
              yield { type: "token", delta: out };
            }
          }
        } else if (ev.type === "tool_call") calls.push({ id: ev.id, name: ev.name, rawArgs: ev.rawArgs });
        else if (ev.type === "usage") addUsage(ev.usage);
      }
      if (streamToUser) {
        const tail = strip.flush();
        if (tail) yield { type: "token", delta: tail };
      }

      if (calls.length === 0) {
        finalRaw = stepText;
        exhausted = false;
        break;
      }

      // ── the model PROPOSES; the app validates, gates and runs ─────────────────────────────
      messages.push({ role: "assistant", text: stepText, toolCalls: calls });
      for (const call of calls) {
        const citable = deps.tools.registry.get(call.name)?.citable === true;
        if (!citable) actionAttempted = true;
        const tainted = sources.some((s) => s.flagged);
        const exec = await executeToolCall(deps.tools, { scope, messageId, step: steps + 1, call, tainted, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        if (exec.status === "succeeded" && !citable) actionSucceeded = true;
        let modelText = exec.modelText;
        if (exec.sources?.length) {
          // search_documents: assign continuing citation numbers, fence the new evidence, extend the taint check.
          const fresh = exec.sources.filter((s) => !sources.some((x) => x.chunkId === s.chunkId));
          const block = buildContextBlock(toFenced(fresh, sources.length + 1), nonce);
          sources.push(...fresh);
          modelText = JSON.stringify({ ...(JSON.parse(exec.modelText) as object), sources: block });
        }
        yield { type: "tool", callId: exec.callId, name: exec.name, status: exec.status, step: steps + 1, ...(exec.errorCode ? { message: exec.errorCode } : {}) };
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, text: modelText });
      }
    }

    /* 4 ── verify what the model claims, server-side */
    const parsed = parseStatusLine(normalizeCitations(finalRaw));
    let content: string;
    let citations: Citation[] = [];
    let abstained = false;
    const valid = new Set(sources.map((_, i) => i + 1));

    if (exhausted) {
      content = "I reached my step limit while working on that. Please try a simpler request.";
    } else if (sources.length === 0 && !actionAttempted) {
      abstained = true;
      content = REFUSAL_NO_DOCS;
    } else if (parsed.status === "not_in_documents" && !actionSucceeded) {
      abstained = true;
      content = stripCitations(parsed.body).trim() || REFUSAL_NO_DOCS;
    } else {
      const v = validateCitations(parsed.body, valid);
      if (v.removed.length) log("warn", "removed fabricated citations", { messageId, removed: v.removed });
      const cleaned = v.text.trim();
      if (v.used.length === 0 && !actionAttempted) {
        // A factual answer with no valid citation is not grounded — do not present it as one.
        abstained = true;
        content = REFUSAL_UNGROUNDED;
        log("warn", "blocked uncited answer", { messageId });
      } else {
        content = cleaned || (actionAttempted ? "Done." : REFUSAL_UNGROUNDED);
        citations = v.used.map((n) => {
          const s = sources[n - 1]!;
          return { n, chunkId: s.chunkId, documentId: s.documentId, documentTitle: s.documentTitle, headingPath: s.headingPath, ordinal: s.ordinal, snippet: snippet(s.content) };
        });
      }
    }

    await deps.conv.finishAssistant(scope, messageId, { content, status: "complete", citations, abstained });
    finalized = true;
    await deps.obs.recordTrace(scope, {
      messageId, kind: "chat", provider: served.provider, model: served.model, usage, latencyMs: now() - started,
      retrievalMs, ...(firstTokenMs !== undefined ? { firstTokenMs } : {}), retrievalHit: r.hit, status: abstained ? "abstained" : "ok",
    });
    yield { type: "done", message: { id: messageId, content, citations, abstained, status: "complete" } };
  } catch (err) {
    const e = mapError(err);
    log("error", "turn failed", { messageId, code: e.code, name: err instanceof Error ? err.name : "unknown" });
    // Best-effort persistence: the failure itself must never lose the user's question (already committed).
    try {
      await deps.conv.finishAssistant(scope, messageId, { content: "", status: "failed", errorCode: e.code });
      finalized = true;
      await deps.obs.recordTrace(scope, { messageId, kind: "chat", provider: served.provider, model: served.model, usage, latencyMs: now() - started, retrievalMs, ...(hit !== undefined ? { retrievalHit: hit } : {}), status: "error", errorCode: e.code });
    } catch {
      /* the DB may be the thing that is down; the earlier commit still holds the question */
    }
    yield { type: "error", code: e.code, message: e.message, retryable: e.retryable, assistantMessageId: messageId };
  } finally {
    // The consumer stopped iterating (client disconnected / request cancelled) before a terminal state was reached:
    // never leave the reply `pending` forever. The user's question is already committed; this makes the reply retryable.
    if (!finalized) {
      try {
        await deps.conv.finishAssistant(scope, messageId, { content: "", status: "failed", errorCode: "aborted" });
      } catch {
        /* best effort */
      }
    }
  }
}
