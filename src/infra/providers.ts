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

const g = globalThis as unknown as { __latticeLlm?: LlmPort; __latticeEmbed?: EmbeddingPort };

/** Provider selection is configuration, not code: swap models/vendors with env vars, no redeploy of logic. */
export function llm(): LlmPort {
  if (g.__latticeLlm) return g.__latticeLlm;
  const e = env();
  let impl: LlmPort;
  if (e.LLM_PROVIDER === "fake") impl = new OfflineLlm();
  else if (e.LLM_PROVIDER === "groq") impl = new GroqLlm(e.GROQ_API_KEY!, e.GROQ_MODEL);
  else {
    const gemini = [e.GEMINI_CHAT_MODEL, ...e.GEMINI_CHAT_FALLBACK_MODELS.split(",").map((m) => m.trim()).filter(Boolean)].map((m) => new GeminiLlm(e.GEMINI_API_KEY!, m));
    const groq = e.GROQ_API_KEY ? [new GroqLlm(e.GROQ_API_KEY, e.GROQ_MODEL)] : [];
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
