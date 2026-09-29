import { DomainError } from "../domain/errors";
import { normalizeText, sanitizeLabel, sha256Hex } from "../domain/text";
import type { DocumentDTO } from "../domain/types";
import type { EmbeddingPort } from "../ports/providers";
import type { ChunkStorePort, DocumentRepo, IngestionJobRepo, NewChunk, ObservabilityRepo } from "../ports/repositories";
import { scanForInjection } from "../security/injection";
import { canWrite, type TenantScope } from "../security/tenant";
import { chunkSections, embeddingInput, sectionizeText } from "./chunker";

export type IngestDeps = {
  docs: DocumentRepo;
  chunks: ChunkStorePort;
  jobs: IngestionJobRepo;
  embedder: EmbeddingPort;
  obs?: ObservabilityRepo;
  now?: () => number;
};

/** Output of a file parser: markdown-ish text. Structure (headings / "Page N") is recovered by the chunker. */
export type ParsedDocument = { title: string; filename: string; mime: string; sizeBytes: number; text: string };

export const MAX_TEXT_CHARS = 1_500_000;
const EMBED_BATCH = 16;
const LEASE_MS = 65_000;

/**
 * Phase 1 — register. Normalise → hash → INSERT … ON CONFLICT (workspace, content_hash).
 * Re-uploading identical content into the same workspace returns the existing document and creates NOTHING new
 * (`created: false`). Different workspaces holding the same file each get their own rows — tenancy is never merged.
 */
export async function registerDocument(deps: IngestDeps, scope: TenantScope, parsed: ParsedDocument): Promise<{ document: DocumentDTO; created: boolean }> {
  if (!canWrite(scope)) throw new DomainError("not_a_member", "Your role cannot upload documents.", 403);
  const { text, hiddenCharCount } = normalizeText(parsed.text);
  if (text.length < 20) throw new DomainError("validation", "The document has no readable text.", 422);
  if (text.length > MAX_TEXT_CHARS) throw new DomainError("payload_too_large", "The document text is too large (limit ≈ 1.5M characters).", 413);

  const contentHash = await sha256Hex(text);
  const result = await deps.docs.createIfAbsent(scope, {
    title: sanitizeLabel(parsed.title, 140) || sanitizeLabel(parsed.filename, 140) || "Untitled",
    filename: sanitizeLabel(parsed.filename, 200) || "upload",
    mime: parsed.mime.slice(0, 100),
    sizeBytes: parsed.sizeBytes,
    contentHash,
    sourceText: text,
    hiddenCharCount,
  });
  if (result.created) await deps.jobs.enqueue(scope, result.document.id);
  return result;
}

export type ProcessOutcome =
  | { state: "ready"; chunks: number; flagged: number }
  | { state: "partial"; embedded: number; total: number } // out of time budget; the job will be resumed
  | { state: "busy" } // another worker holds the lease, or the job is already finished
  | { state: "failed"; error: string };

/**
 * Phase 2 — process. Leased, checkpointed and resumable:
 *  - the lease means two concurrent triggers (upload + dashboard sweep) never embed the same document twice;
 *  - chunk upserts are keyed on (document, ordinal), and chunking is deterministic, so resuming after a crash or a
 *    serverless timeout re-does at most one batch and can never create duplicates.
 */
export async function processIngestion(deps: IngestDeps, scope: TenantScope, documentId: string, opts: { budgetMs?: number } = {}): Promise<ProcessOutcome> {
  const now = deps.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? 45_000);

  const claim = await deps.jobs.claim(scope, documentId, LEASE_MS);
  if (!claim) return { state: "busy" };

  try {
    await deps.docs.markStatus(scope, documentId, "processing", { error: null });
    const source = await deps.docs.getSource(scope, documentId);
    if (!source) throw new Error("source text missing");

    const drafts = chunkSections(sectionizeText(source.text));
    const hiddenFlag = source.hiddenCharCount > 0;
    let flagged = 0;
    let next = claim.checkpoint;

    // Recount flags for already-persisted batches deterministically (same text ⇒ same scan result).
    const scan = (content: string) => scanForInjection(content, { hiddenCharCount: hiddenFlag ? source.hiddenCharCount : 0 });
    for (const d of drafts.slice(0, next)) if (scan(d.content).flagged) flagged++;

    while (next < drafts.length) {
      if (now() > deadline) {
        await deps.jobs.checkpoint(scope, documentId, next, { release: true }); // hand the lease back: next trigger resumes at once
        return { state: "partial", embedded: next, total: drafts.length };
      }
      const batch = drafts.slice(next, next + EMBED_BATCH);
      const vectors = await deps.embedder.embed(batch.map(embeddingInput), "document");
      if (vectors.length !== batch.length) throw new Error("embedding provider returned a wrong number of vectors");

      const rows: NewChunk[] = batch.map((d, i) => {
        const s = scan(d.content);
        if (s.flagged) flagged++;
        return { ...d, embedding: vectors[i]!, flagged: s.flagged, flagReasons: s.reasons };
      });
      await deps.chunks.upsertChunks(scope, documentId, deps.embedder.model, rows);
      next += batch.length;
      await deps.jobs.checkpoint(scope, documentId, next);
    }

    const stored = await deps.chunks.countForDocument(scope, documentId);
    if (stored !== drafts.length) throw new Error(`chunk count mismatch (expected ${drafts.length}, stored ${stored})`);

    await deps.docs.markStatus(scope, documentId, "ready", { error: null, chunkCount: stored, flaggedChunkCount: flagged });
    await deps.jobs.finish(scope, documentId, { ok: true });
    return { state: "ready", chunks: stored, flagged };
  } catch (err) {
    const message = describeIngestError(err);
    await deps.docs.markStatus(scope, documentId, "failed", { error: message });
    await deps.jobs.finish(scope, documentId, { ok: false, error: message });
    return { state: "failed", error: message };
  }
}

/** A user-safe error string: never includes provider payloads, keys, or document text. */
function describeIngestError(err: unknown): string {
  if (err instanceof DomainError) return err.message;
  const msg = err instanceof Error ? err.message : "";
  if (/rate|quota|429/i.test(msg)) return "The embedding provider is rate-limited right now. Retry in a minute.";
  if (/timeout|timed out|abort/i.test(msg)) return "The embedding provider timed out. Retry to resume where it stopped.";
  if (/mismatch|wrong number/i.test(msg)) return "Internal consistency check failed. Retry to resume.";
  return "Ingestion failed. Retry to resume where it stopped.";
}

/** User-initiated retry of a failed/stalled document. Resumes from the last checkpoint. */
export async function retryIngestion(deps: IngestDeps, scope: TenantScope, documentId: string): Promise<ProcessOutcome> {
  if (!canWrite(scope)) throw new DomainError("not_a_member", "Your role cannot modify documents.", 403);
  const doc = await deps.docs.get(scope, documentId);
  if (!doc || doc.workspaceId !== scope.workspaceId) throw new DomainError("not_found", "Document not found.", 404);
  await deps.jobs.requeue(scope, documentId);
  return processIngestion(deps, scope, documentId);
}
