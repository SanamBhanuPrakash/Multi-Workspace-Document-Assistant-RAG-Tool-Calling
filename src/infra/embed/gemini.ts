import "server-only";
import type { EmbeddingPort } from "@/core/ports/providers";
import { ProviderError } from "@/core/domain/errors";
import { EMBEDDING_DIMENSIONS } from "../db/schema";
import { fetchWithRetry } from "../http";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_BATCH = 100;

/** L2-normalise: Gemini returns unit-length vectors only for the full 3072 dims; truncated (MRL) vectors must be re-normalised. */
export function l2normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

export class GeminiEmbedding implements EmbeddingPort {
  readonly dimensions = EMBEDDING_DIMENSIONS;
  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async embed(texts: string[], kind: "document" | "query", signal?: AbortSignal): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH);
      const res = await fetchWithRetry(
        `${BASE}/models/${this.model}:batchEmbedContents`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey }, // key in a header, never in the URL/logs
          body: JSON.stringify({
            requests: batch.map((text) => ({
              model: `models/${this.model}`,
              content: { parts: [{ text }] },
              taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
              outputDimensionality: this.dimensions,
            })),
          }),
        },
        { attempts: 5, attemptTimeoutMs: 30_000, deadlineMs: 55_000, ...(signal ? { signal } : {}) },
      );
      const json = (await res.json()) as { embeddings?: { values?: number[] }[] };
      const vectors = json.embeddings?.map((e) => e.values);
      if (!vectors || vectors.length !== batch.length || vectors.some((v) => !v || v.length !== this.dimensions)) {
        throw new ProviderError("unavailable", "The embedding provider returned an unexpected response.");
      }
      out.push(...vectors.map((v) => l2normalize(v!)));
    }
    return out;
  }
}
