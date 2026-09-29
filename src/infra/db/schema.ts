import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export * from "./auth-schema";

/** Embedding dimensionality is a schema-level constant; `embedding_model` is stored per row so a model change is a controlled migration. */
export const EMBEDDING_DIMENSIONS = 768;

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/* ───────────────────────────── tenancy ───────────────────────────── */

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** Stable identity colour shown across UI so the active tenant is always visible. */
    color: text("color").notNull().default("#5b8def"),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("workspaces_owner_slug_uq").on(t.ownerId, t.slug),
    check("workspaces_name_len", sql`char_length(${t.name}) between 1 and 80`),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("memberships_user_idx").on(t.userId),
    check("memberships_role_chk", sql`${t.role} in ('owner','admin','member','viewer')`),
  ],
);

/* ───────────────────────────── documents & the ONE shared vector store ───────────────────────────── */

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** SHA-256 of the normalised text. Idempotency key together with workspace_id. */
    contentHash: text("content_hash").notNull(),
    status: text("status").notNull().default("queued"),
    error: text("error"),
    chunkCount: integer("chunk_count").notNull().default(0),
    flaggedChunkCount: integer("flagged_chunk_count").notNull().default(0),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("documents_ws_hash_uq").on(t.workspaceId, t.contentHash), // idempotent ingestion
    unique("documents_id_ws_uq").on(t.id, t.workspaceId), // target for composite FKs (tenant integrity)
    index("documents_ws_created_idx").on(t.workspaceId, t.createdAt),
    check("documents_status_chk", sql`${t.status} in ('queued','processing','ready','failed')`),
  ],
);

/** Normalised source text, kept so ingestion can resume/re-chunk without the original upload. */
export const documentSources = pgTable(
  "document_sources",
  {
    documentId: uuid("document_id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    text: text("text").notNull(),
    /** Invisible characters stripped at ingestion. Non-zero taints every chunk of the document (hidden-text signal). */
    hiddenCharCount: integer("hidden_char_count").notNull().default(0),
  },
  (t) => [
    foreignKey({
      columns: [t.documentId, t.workspaceId],
      foreignColumns: [documents.id, documents.workspaceId],
      name: "document_sources_doc_ws_fk",
    }).onDelete("cascade"),
  ],
);

/**
 * THE shared vector store. One table for every workspace. `workspace_id` is NOT NULL, is part of a composite FK to the
 * owning document (a chunk can never claim a different workspace than its document), and is the first predicate of every
 * retrieval query plus the basis of the RLS policy.
 */
export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    documentId: uuid("document_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    headingPath: text("heading_path").notNull().default(""),
    content: text("content").notNull(),
    tokenCount: integer("token_count").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    embeddingModel: text("embedding_model").notNull(),
    /** Set by the ingestion-time injection scanner. Flagged chunks are still retrievable but taint the request. */
    flagged: boolean("flagged").notNull().default(false),
    flagReasons: text("flag_reasons").array().notNull().default(sql`'{}'::text[]`),
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('english', coalesce(heading_path,'') || ' ' || content)`),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.documentId, t.workspaceId],
      foreignColumns: [documents.id, documents.workspaceId],
      name: "chunks_doc_ws_fk",
    }).onDelete("cascade"),
    unique("chunks_doc_ordinal_uq").on(t.documentId, t.ordinal), // idempotent chunk upserts
    index("chunks_ws_doc_idx").on(t.workspaceId, t.documentId),
    index("chunks_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")).with({ m: 16, ef_construction: 64 }),
    index("chunks_tsv_gin").using("gin", t.tsv),
  ],
);

export const ingestionJobs = pgTable(
  "ingestion_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    documentId: uuid("document_id").notNull(),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    /** Next chunk ordinal to embed — the checkpoint that makes the job resumable. */
    checkpoint: integer("checkpoint").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.documentId, t.workspaceId],
      foreignColumns: [documents.id, documents.workspaceId],
      name: "ingestion_jobs_doc_ws_fk",
    }).onDelete("cascade"),
    unique("ingestion_jobs_doc_uq").on(t.documentId),
    index("ingestion_jobs_status_idx").on(t.status, t.lockedUntil),
    check("ingestion_jobs_status_chk", sql`${t.status} in ('queued','running','failed','done')`),
  ],
);

/** Opt-in cross-workspace sharing. Default isolation is unchanged: no row here ⇒ no visibility. */
export const documentShares = pgTable(
  "document_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull(),
    sourceWorkspaceId: uuid("source_workspace_id").notNull(),
    targetWorkspaceId: uuid("target_workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.documentId, t.sourceWorkspaceId],
      foreignColumns: [documents.id, documents.workspaceId],
      name: "document_shares_doc_ws_fk",
    }).onDelete("cascade"),
    unique("document_shares_doc_target_uq").on(t.documentId, t.targetWorkspaceId),
    index("document_shares_target_idx").on(t.targetWorkspaceId),
    check("document_shares_distinct", sql`${t.sourceWorkspaceId} <> ${t.targetWorkspaceId}`),
  ],
);

/* ───────────────────────────── conversations ───────────────────────────── */

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New conversation"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("conversations_id_ws_uq").on(t.id, t.workspaceId), index("conversations_ws_updated_idx").on(t.workspaceId, t.updatedAt)],
);

export type Citation = {
  n: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  headingPath: string;
  ordinal: number;
  snippet: string;
};

/**
 * `status` is what makes the pipeline durable: the user message and a `pending` assistant row are committed BEFORE any
 * LLM call, so a slow/failed provider never loses the question — the row flips to `failed` and can be retried.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Monotonic order within the whole table. created_at cannot order a turn: both rows share the transaction's now(). */
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    conversationId: uuid("conversation_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull().default(""),
    status: text("status").notNull().default("complete"),
    errorCode: text("error_code"),
    citations: jsonb("citations").$type<Citation[]>().notNull().default(sql`'[]'::jsonb`),
    /** True when the assistant declined because the workspace's documents do not contain the answer. */
    abstained: boolean("abstained").notNull().default(false),
    /** Links an assistant reply to the user message that produced it (retry & dedupe). */
    replyToId: uuid("reply_to_id"),
    /** Client-generated id for the user's send. Makes a double-submit / retry idempotent per conversation. */
    clientRequestId: text("client_request_id"),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.conversationId, t.workspaceId],
      foreignColumns: [conversations.id, conversations.workspaceId],
      name: "messages_conv_ws_fk",
    }).onDelete("cascade"),
    unique("messages_id_ws_uq").on(t.id, t.workspaceId),
    index("messages_conv_created_idx").on(t.conversationId, t.createdAt),
    uniqueIndex("messages_client_req_uq").on(t.conversationId, t.clientRequestId).where(sql`${t.clientRequestId} is not null`),
    check("messages_role_chk", sql`${t.role} in ('user','assistant')`),
    check("messages_status_chk", sql`${t.status} in ('pending','streaming','complete','failed')`),
  ],
);

/* ───────────────────────────── tools ───────────────────────────── */

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").notNull(),
    step: integer("step").notNull(),
    /** Exactly what the model asked for — may be an unknown tool. Never trusted, only recorded. */
    toolName: text("tool_name").notNull(),
    rawArgs: text("raw_args").notNull(),
    validatedArgs: jsonb("validated_args"),
    status: text("status").notNull(),
    result: jsonb("result"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    latencyMs: integer("latency_ms"),
    idempotencyKey: text("idempotency_key").notNull(),
    /** True when flagged (possibly hostile) document text was in the model's context for this request. */
    tainted: boolean("tainted").notNull().default(false),
    confirmedBy: text("confirmed_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.messageId, t.workspaceId],
      foreignColumns: [messages.id, messages.workspaceId],
      name: "tool_calls_msg_ws_fk",
    }).onDelete("cascade"),
    unique("tool_calls_idem_uq").on(t.workspaceId, t.idempotencyKey), // a retry can never double-fire a side effect
    index("tool_calls_ws_created_idx").on(t.workspaceId, t.createdAt),
    check(
      "tool_calls_status_chk",
      sql`${t.status} in ('rejected','awaiting_confirmation','running','succeeded','failed','declined')`,
    ),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    priority: text("priority").notNull().default("normal"),
    dueDate: text("due_date"),
    status: text("status").notNull().default("open"),
    createdByToolCallId: uuid("created_by_tool_call_id").references(() => toolCalls.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("tasks_ws_created_idx").on(t.workspaceId, t.createdAt),
    check("tasks_title_len", sql`char_length(${t.title}) between 1 and 200`),
    check("tasks_priority_chk", sql`${t.priority} in ('low','normal','high')`),
    check("tasks_status_chk", sql`${t.status} in ('open','done')`),
  ],
);

/** Channel webhooks. The URL is a bearer secret: stored AES-256-GCM encrypted, never returned to the client. */
export const workspaceIntegrations = pgTable(
  "workspace_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    /** Non-secret hint for the UI, e.g. "hooks.slack.com/…a1b2". */
    hint: text("hint").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [unique("workspace_integrations_kind_uq").on(t.workspaceId, t.kind), check("workspace_integrations_kind_chk", sql`${t.kind} in ('slack','discord')`)],
);

/* ───────────────────────────── observability ───────────────────────────── */

export type RetrievalResultRow = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  ordinal: number;
  workspaceId: string;
  sharedFrom: string | null;
  vectorRank: number | null;
  keywordRank: number | null;
  vectorSimilarity: number | null;
  keywordScore: number | null;
  rrfScore: number;
  flagged: boolean;
  usedInContext: boolean;
};

export const retrievalEvents = pgTable(
  "retrieval_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    messageId: uuid("message_id"),
    query: text("query").notNull(),
    standaloneQuery: text("standalone_query").notNull(),
    hit: boolean("hit").notNull(),
    topSimilarity: real("top_similarity"),
    results: jsonb("results").$type<RetrievalResultRow[]>().notNull(),
    params: jsonb("params").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("retrieval_events_ws_created_idx").on(t.workspaceId, t.createdAt), index("retrieval_events_msg_idx").on(t.messageId)],
);

export const requestTraces = pgTable(
  "request_traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    messageId: uuid("message_id"),
    kind: text("kind").notNull(),
    provider: text("provider"),
    model: text("model"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    latencyMs: integer("latency_ms").notNull(),
    retrievalMs: integer("retrieval_ms"),
    firstTokenMs: integer("first_token_ms"),
    retrievalHit: boolean("retrieval_hit"),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    createdAt: createdAt(),
  },
  (t) => [index("request_traces_ws_created_idx").on(t.workspaceId, t.createdAt), check("request_traces_kind_chk", sql`${t.kind} in ('chat','ingest','embed')`)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_ws_created_idx").on(t.workspaceId, t.createdAt)],
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);
