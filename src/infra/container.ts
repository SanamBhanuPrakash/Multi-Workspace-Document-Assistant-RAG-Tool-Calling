import "server-only";
import type { AskDeps } from "@/core/application/ask";
import { makeRetriever } from "@/core/application/ask";
import type { IngestDeps } from "@/core/application/ingest";
import type { ExecutorDeps } from "@/core/application/tools/executor";
import { defaultTools, type ToolDeps } from "@/core/application/tools/registry";
import { chunkStore, conversationRepo, documentRepo, ingestionJobRepo, integrationRepo, observabilityRepo, rateLimiter, taskRepo, toolCallRepo } from "./db/repositories";
import { logger } from "./logging/logger";
import { embedder, llm, notifier } from "./providers";

/**
 * Composition root: the ONLY place ports are bound to adapters. Everything upstream (use-cases) is provider-agnostic,
 * which is what lets tests substitute scripted models and lets ops swap Gemini/Groq by configuration.
 */
export const ingestDeps = (): IngestDeps => ({ docs: documentRepo, chunks: chunkStore, jobs: ingestionJobRepo, embedder: embedder(), obs: observabilityRepo });

export function toolExecutorDeps(): ExecutorDeps {
  const toolDeps: ToolDeps = {
    tasks: taskRepo,
    integrations: integrationRepo,
    notifier: notifier(),
    retrieve: makeRetriever({ chunks: chunkStore, embedder: embedder() }),
  };
  return { registry: defaultTools(), calls: toolCallRepo, toolDeps };
}

export function askDeps(): AskDeps {
  return {
    conv: conversationRepo,
    chunks: chunkStore,
    obs: observabilityRepo,
    embedder: embedder(),
    llm: llm(),
    limiter: rateLimiter,
    tools: toolExecutorDeps(),
    log: (level, msg, fields) => logger[level](fields ?? {}, msg),
  };
}
