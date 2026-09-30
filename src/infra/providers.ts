import "server-only";
import type { EmbeddingPort, LlmPort, NotifierPort } from "@/core/ports/providers";
import { env } from "./env";
import { FakeEmbedding } from "./embed/fake";
import { GeminiEmbedding } from "./embed/gemini";
import { ChainLlm } from "./llm/fallback";
import { GeminiLlm } from "./llm/gemini";
import { GroqLlm } from "./llm/groq";
import { OfflineLlm } from "./llm/offline";
import { webhookNotifier } from "./notify/webhook";

const FAIL_FAST_RETRY_AFTER_MS = 2_000;

const g = globalThis as unknown as { __latticeLlm?: LlmPort; __latticeEmbed?: EmbeddingPort };

/** Provider selection is configuration, not code: swap models/vendors with env vars, no redeploy of logic. */
export function llm(): LlmPort {
  if (g.__latticeLlm) return g.__latticeLlm;
  const e = env();
  let impl: LlmPort;
  if (e.LLM_PROVIDER === "fake") impl = new OfflineLlm();
  else if (e.LLM_PROVIDER === "groq") impl = new GroqLlm(e.GROQ_API_KEY!, e.GROQ_MODEL);
  else {
    // Every link except the last has a fallback behind it, so it gives up on a long Retry-After at once; the last link may wait.
    const geminiModels = [e.GEMINI_CHAT_MODEL, ...e.GEMINI_CHAT_FALLBACK_MODELS.split(",").map((m) => m.trim()).filter(Boolean)];
    const total = geminiModels.length + (e.GROQ_API_KEY ? 1 : 0);
    const failFast = (i: number) => (i < total - 1 ? FAIL_FAST_RETRY_AFTER_MS : undefined);
    const gemini = geminiModels.map((m, i) => new GeminiLlm(e.GEMINI_API_KEY!, m, failFast(i)));
    const groq = e.GROQ_API_KEY ? [new GroqLlm(e.GROQ_API_KEY, e.GROQ_MODEL, failFast(geminiModels.length))] : [];
    const links = [...gemini, ...groq];
    impl = links.length > 1 ? new ChainLlm(links) : links[0]!;
  }
  g.__latticeLlm = impl;
  return impl;
}

export function embedder(): EmbeddingPort {
  if (g.__latticeEmbed) return g.__latticeEmbed;
  const e = env();
  g.__latticeEmbed = e.EMBED_PROVIDER === "fake" ? new FakeEmbedding() : new GeminiEmbedding(e.GEMINI_API_KEY!, e.GEMINI_EMBED_MODEL);
  return g.__latticeEmbed;
}

export const notifier = (): NotifierPort => webhookNotifier;
