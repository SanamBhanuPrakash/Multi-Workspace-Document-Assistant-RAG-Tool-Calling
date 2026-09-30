import type { TenantScope } from "../security/tenant";
import type {
  Citation,
  DocumentDTO,
  MessageDTO,
  RetrievalParams,
  RetrievedChunk,
  TaskDTO,
  ToolCallDTO,
  ToolCallStatus,
  Usage,
} from "../domain/types";
import type { ChunkDraft } from "../application/chunker";

/**
 * Every method that touches tenant data takes a TenantScope first. Implementations run each call in a SHORT transaction
 * (never held across an LLM call) under the RLS-subject role — see src/infra/db/client.ts.
 */

export interface DocumentRepo {
  /** Idempotent on (workspace, contentHash): returns the existing row if this content is already in the workspace. */
  createIfAbsent(
    scope: TenantScope,
    input: { title: string; filename: string; mime: string; sizeBytes: number; contentHash: string; sourceText: string; hiddenCharCount: number },
  ): Promise<{ document: DocumentDTO; created: boolean }>;
  get(scope: TenantScope, documentId: string): Promise<DocumentDTO | null>;
  list(scope: TenantScope): Promise<DocumentDTO[]>;
  getSource(scope: TenantScope, documentId: string): Promise<{ text: string; hiddenCharCount: number } | null>;
  markStatus(scope: TenantScope, documentId: string, status: DocumentDTO["status"], patch?: { error?: string | null; chunkCount?: number; flaggedChunkCount?: number }): Promise<void>;
  delete(scope: TenantScope, documentId: string): Promise<boolean>;
}

export type NewChunk = ChunkDraft & { embedding: number[]; flagged: boolean; flagReasons: string[] };

export interface ChunkStorePort {
  /** Upsert on (document_id, ordinal) so a resumed or repeated ingestion never duplicates chunks. */
  upsertChunks(scope: TenantScope, documentId: string, embeddingModel: string, chunks: NewChunk[]): Promise<void>;
  countForDocument(scope: TenantScope, documentId: string): Promise<number>;
  /**
   * Hybrid (vector + keyword) retrieval fused with RRF. The workspace predicate is part of the SAME SQL statement as the
   * ANN ordering and the full-text branch — never applied after the fact.
   */
  hybridSearch(scope: TenantScope, input: { embedding: number[]; text: string; params: RetrievalParams }): Promise<RetrievedChunk[]>;
}

export interface IngestionJobRepo {
  enqueue(scope: TenantScope, documentId: string): Promise<void>;
  /** User-initiated retry: reset attempts and clear the lease so the job can be claimed again. */
  requeue(scope: TenantScope, documentId: string): Promise<void>;
  /** Claim a job with a lease so concurrent workers/requests never process the same document twice. */
  claim(scope: TenantScope, documentId: string, leaseMs: number): Promise<{ checkpoint: number; attempts: number } | null>;
  /** Record progress and extend the lease; `release` also drops the lease so the next trigger resumes immediately. */
  checkpoint(scope: TenantScope, documentId: string, nextOrdinal: number, opts?: { release?: boolean }): Promise<void>;
  finish(scope: TenantScope, documentId: string, outcome: { ok: true } | { ok: false; error: string }): Promise<void>;
}

export type NewMessage = { role: "user" | "assistant"; content: string; status: MessageDTO["status"]; replyToId?: string; clientRequestId?: string };

export interface ConversationRepo {
  createConversation(scope: TenantScope, title: string): Promise<string>;
  conversationExists(scope: TenantScope, conversationId: string): Promise<boolean>;
  listConversations(scope: TenantScope): Promise<{ id: string; title: string; updatedAt: string }[]>;
  /** Idempotent on (conversation, clientRequestId): a double-submit returns the original pair. */
  beginTurn(
    scope: TenantScope,
    input: { conversationId: string; text: string; clientRequestId: string },
  ): Promise<{ userMessage: MessageDTO; assistantMessage: MessageDTO; created: boolean }>;
  history(scope: TenantScope, conversationId: string, limit: number): Promise<MessageDTO[]>;
  finishAssistant(
    scope: TenantScope,
    messageId: string,
    patch: { content: string; status: "complete" | "failed"; errorCode?: string | null; citations?: Citation[]; abstained?: boolean },
  ): Promise<void>;
  getMessage(scope: TenantScope, messageId: string): Promise<MessageDTO | null>;
  /** Re-open a failed assistant reply for retry. Returns null if it is not in a retryable state. */
  reopenFailed(scope: TenantScope, assistantMessageId: string): Promise<{ userMessage: MessageDTO; assistantMessage: MessageDTO } | null>;
}

export type NewToolCall = {
  messageId: string;
  step: number;
  toolName: string;
  rawArgs: string;
  validatedArgs?: unknown;
  status: ToolCallStatus;
  errorCode?: string;
  errorMessage?: string;
  idempotencyKey: string;
  tainted: boolean;
};

export interface ToolCallRepo {
  /** Insert-or-return on (workspace, idempotencyKey). `created=false` means an identical call already exists. */
  begin(scope: TenantScope, input: NewToolCall): Promise<{ call: ToolCallDTO; created: boolean }>;
  finish(scope: TenantScope, id: string, patch: { status: ToolCallStatus; result?: unknown; errorCode?: string; errorMessage?: string; latencyMs?: number; confirmedBy?: string }): Promise<void>;
  /**
   * Atomically move a HELD call out of `awaiting_confirmation` (compare-and-set on the status). Exactly one concurrent caller
   * gets `true`; everyone else gets `false` and must not run the tool. This is what makes a double-clicked "Approve" safe.
   */
  claimHeld(scope: TenantScope, id: string, patch: { status: "running" | "declined"; errorCode?: string; errorMessage?: string; confirmedBy: string }): Promise<boolean>;
  get(scope: TenantScope, id: string): Promise<ToolCallDTO | null>;
  list(scope: TenantScope, limit: number): Promise<ToolCallDTO[]>;
}

export interface TaskRepo {
  create(scope: TenantScope, input: { title: string; description?: string | null; priority: TaskDTO["priority"]; dueDate?: string | null; toolCallId?: string }): Promise<TaskDTO>;
  list(scope: TenantScope, status: "open" | "done" | "all", limit: number): Promise<TaskDTO[]>;
}

export interface IntegrationRepo {
  /** Returns the decrypted webhook URL. Never expose the result to a client or to logs. */
  getWebhookUrl(scope: TenantScope, kind: "slack" | "discord"): Promise<string | null>;
  save(scope: TenantScope, kind: "slack" | "discord", webhookUrl: string): Promise<{ hint: string }>;
  list(scope: TenantScope): Promise<{ kind: "slack" | "discord"; hint: string }[]>;
  remove(scope: TenantScope, kind: "slack" | "discord"): Promise<void>;
}

export type RetrievalEventInput = {
  messageId: string;
  query: string;
  standaloneQuery: string;
  hit: boolean;
  topSimilarity: number | null;
  results: unknown;
  params: RetrievalParams;
  latencyMs: number;
};

export type TraceInput = {
  messageId?: string;
  kind: "chat" | "ingest" | "embed";
  provider?: string;
  model?: string;
  usage?: Usage;
  latencyMs: number;
  retrievalMs?: number;
  firstTokenMs?: number;
  retrievalHit?: boolean;
  status: "ok" | "error" | "abstained";
  errorCode?: string;
};

export interface ObservabilityRepo {
  recordRetrieval(scope: TenantScope, input: RetrievalEventInput): Promise<void>;
  recordTrace(scope: TenantScope, input: TraceInput): Promise<void>;
}

export interface RateLimiterPort {
  /** Sliding-window-ish counter. Returns false when the caller must be refused. */
  allow(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}

export interface MembershipRepo {
  roleOf(userId: string, workspaceId: string): Promise<"owner" | "admin" | "member" | "viewer" | null>;
}
