import type { IngestDeps } from "@/core/application/ingest";
import type { EmbeddingPort } from "@/core/ports/providers";
import { resolveTenantScope, type TenantScope } from "@/core/security/tenant";
import { FakeEmbedding } from "@/infra/embed/fake";
import { chunkStore, documentRepo, ingestionJobRepo, membershipLookup, observabilityRepo } from "@/infra/db/repositories";

export const realIngestDeps = (embedder: EmbeddingPort = new FakeEmbedding(), extra: Partial<IngestDeps> = {}): IngestDeps => ({
  docs: documentRepo,
  chunks: chunkStore,
  jobs: ingestionJobRepo,
  embedder,
  obs: observabilityRepo,
  ...extra,
});

/** The production path: membership is verified before a scope exists. */
export const scopeFor = (userId: string, workspaceId: string): Promise<TenantScope> => resolveTenantScope(membershipLookup, userId, workspaceId);

export const doc = (title: string, text: string) => ({
  title,
  filename: `${title}.md`,
  mime: "text/markdown",
  sizeBytes: text.length,
  text,
});
