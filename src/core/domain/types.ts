/** Plain data shapes shared across core, infra and UI. No behaviour. */

export type DocumentStatus = "queued" | "processing" | "ready" | "failed";

export type DocumentDTO = {
  id: string;
  workspaceId: string;
  title: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  status: DocumentStatus;
  error: string | null;
  chunkCount: number;
  flaggedChunkCount: number;
  createdAt: string;
  /** Set when the document lives in ANOTHER workspace and was explicitly shared into this one. */
  sharedFromWorkspaceId: string | null;
};

export type RetrievedChunk = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  headingPath: string;
  ordinal: number;
  content: string;
  /** The workspace that OWNS the chunk. Equals the active workspace unless explicitly shared in. */
  workspaceId: string;
  sharedFrom: string | null;
  vectorRank: number | null;
  keywordRank: number | null;
  vectorSimilarity: number | null;
  keywordScore: number | null;
  rrfScore: number;
  flagged: boolean;
};

export type RetrievalParams = {
  k: number;
  candidatePool: number;
  rrfK: number;
  minSimilarity: number;
};

export type Citation = {
  n: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  headingPath: string;
  ordinal: number;
  snippet: string;
};

export type MessageStatus = "pending" | "streaming" | "complete" | "failed";

export type MessageDTO = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  errorCode: string | null;
  citations: Citation[];
  abstained: boolean;
  createdAt: string;
};

export type ToolCallStatus = "rejected" | "awaiting_confirmation" | "running" | "succeeded" | "failed" | "declined";

export type ToolCallDTO = {
  id: string;
  messageId: string;
  step: number;
  toolName: string;
  rawArgs: string;
  validatedArgs: unknown;
  status: ToolCallStatus;
  result: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
  tainted: boolean;
  createdAt: string;
};

export type TaskDTO = {
  id: string;
  title: string;
  description: string | null;
  priority: "low" | "normal" | "high";
  dueDate: string | null;
  status: "open" | "done";
  createdAt: string;
};

export type WorkspaceDTO = { id: string; name: string; slug: string; color: string; role: string };

/** Token usage reported by a provider; zero when the provider does not report it. */
export type Usage = { tokensIn: number; tokensOut: number };

export type ConversationSummary = { id: string; title: string; updatedAt: string };

export type ObservabilitySummary = {
  windowHours: number;
  requests: number;
  errors: number;
  abstained: number;
  retrievalHitRate: number | null;
  latencyMs: { p50: number | null; p95: number | null; avg: number | null };
  firstTokenMs: { p50: number | null };
  tokensIn: number;
  tokensOut: number;
  byProvider: { provider: string; model: string; requests: number; tokensIn: number; tokensOut: number }[];
  tools: { name: string; status: string; count: number }[];
  ingestion: { ready: number; failed: number; processing: number };
  hourly: { hour: string; requests: number; errors: number; p95Ms: number | null }[];
};

export type RetrievalEventDTO = {
  id: string;
  messageId: string | null;
  query: string;
  standaloneQuery: string;
  hit: boolean;
  topSimilarity: number | null;
  latencyMs: number;
  createdAt: string;
  workspaceId: string;
  params: RetrievalParams;
  results: RetrievalResultRow[];
};

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
