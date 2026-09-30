import { after } from "next/server";
import { DomainError } from "@/core/domain/errors";
import { registerDocument, processIngestion } from "@/core/application/ingest";
import { canWrite } from "@/core/security/tenant";
import { ingestDeps } from "@/infra/container";
import { documentRepo, rateLimiter, shareRepo } from "@/infra/db/repositories";
import { MAX_REQUEST_BYTES, parseUpload } from "@/infra/parsers";
import { logger, safeError } from "@/infra/logging/logger";
import { json, workspaceRoute } from "../../../_lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Hobby ceiling; ingestion is checkpointed so it resumes if it runs out
const MAX_FILES = 5;

export const GET = workspaceRoute({}, async ({ scope, requestId }) => {
  const documents = await documentRepo.list(scope);
  const shares = await shareRepo.outgoing(scope);
  // Self-healing: documents whose worker died (serverless timeout / cold restart) are resumed whenever the list is viewed.
  const stalled = documents.filter((d) => d.workspaceId === scope.workspaceId && (d.status === "queued" || d.status === "processing") && Date.now() - new Date(d.createdAt).getTime() > 20_000);
  if (stalled.length && canWrite(scope)) {
    after(async () => {
      for (const d of stalled.slice(0, 2)) await processIngestion(ingestDeps(), scope, d.id).catch((e: unknown) => logger.warn({ err: safeError(e) }, "resume failed"));
    });
  }
  return json({ documents, shares }, requestId);
});

export const POST = workspaceRoute({ mutating: true }, async ({ req, scope, user, requestId }) => {
  if (!canWrite(scope)) throw new DomainError("not_a_member", "Your role cannot upload documents.", 403);
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_REQUEST_BYTES) throw new DomainError("payload_too_large", "Uploads are limited to 4 MB per request. Upload fewer or smaller files.", 413);
  if (!(await rateLimiter.allow(`upload:${user.id}`, 30, 3600))) throw new DomainError("rate_limited", "Too many uploads. Try again later.", 429);

  const form = await req.formData().catch(() => {
    throw new DomainError("validation", "Expected a multipart form upload.", 422);
  });
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) throw new DomainError("validation", "No files were provided.", 422);
  if (files.length > MAX_FILES) throw new DomainError("validation", `Upload at most ${MAX_FILES} files at a time.`, 422);

  const deps = ingestDeps();
  const results: { filename: string; outcome: "created" | "duplicate" | "rejected"; document?: unknown; error?: { code: string; message: string } }[] = [];
  const toProcess: string[] = [];
  for (const file of files) {
    try {
      const parsed = await parseUpload({ filename: file.name.slice(0, 200), bytes: new Uint8Array(await file.arrayBuffer()) });
      const { document, created } = await registerDocument(deps, scope, parsed);
      if (created) toProcess.push(document.id);
      results.push({ filename: file.name, outcome: created ? "created" : "duplicate", document });
    } catch (err) {
      const e = err instanceof DomainError ? err : null;
      if (!e) logger.error({ requestId, err: safeError(err) }, "upload failed unexpectedly");
      results.push({ filename: file.name, outcome: "rejected", error: { code: e?.code ?? "internal", message: e?.message ?? "Could not process this file." } });
    }
  }

  // Respond immediately; embed in the background. The client polls the document list for status.
  after(async () => {
    for (const id of toProcess) {
      const out = await processIngestion(deps, scope, id).catch((e: unknown) => ({ state: "failed" as const, error: safeError(e).message }));
      logger.info({ requestId, documentId: id, state: out.state }, "ingestion finished");
    }
  });
  return json({ results }, requestId, 202);
});
