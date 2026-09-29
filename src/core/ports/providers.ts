import type { Usage } from "../domain/types";

/** Embeddings. `kind` lets providers use asymmetric query/document task types. */
export interface EmbeddingPort {
  readonly model: string;
  readonly dimensions: number;
  /**
   * Cosine similarity below which a chunk is treated as "not about this question". Model-specific: it must be calibrated
   * per embedding model (Gemini scores unrelated text around 0.5, a hashing embedder around 0). See tests/evals.
   */
  readonly minRelevance: number;
  embed(texts: string[], kind: "document" | "query", signal?: AbortSignal): Promise<number[][]>;
}

export type ToolDeclaration = {
  name: string;
  description: string;
  /** JSON Schema (draft-7 subset) for the arguments object. */
  parameters: Record<string, unknown>;
};

export type LlmMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls?: { id: string; name: string; rawArgs: string }[] }
  | { role: "tool"; toolCallId: string; name: string; text: string };

export type LlmRequest = {
  system: string;
  messages: LlmMessage[];
  tools: ToolDeclaration[];
  temperature?: number;
  maxOutputTokens?: number;
};

export type LlmEvent =
  /** Which model actually serves this call (a failover chain may switch). Not counted as output by the chain. */
  | { type: "meta"; provider: string; model: string }
  | { type: "text"; delta: string }
  /** `rawArgs` is exactly what the model produced (a JSON string). It is untrusted until validated. */
  | { type: "tool_call"; id: string; name: string; rawArgs: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finishReason: "stop" | "tool_calls" | "length" | "other" };

export interface LlmPort {
  readonly provider: string;
  readonly model: string;
  generate(request: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmEvent>;
}

/** Outbound notification channel (Slack / Discord). URL is a secret and must never be logged. */
export interface NotifierPort {
  send(kind: "slack" | "discord", webhookUrl: string, message: { title: string; body: string }, signal?: AbortSignal): Promise<void>;
}
