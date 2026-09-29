import { after } from "next/server";
import { DomainError, notFound } from "@/core/domain/errors";
import { processIngestion } from "@/core/application/ingest";
import { canWrite, isUuid } from "@/core/security/tenant";
import { ingestDeps } from "@/infra/container";
import { documentRepo, ingestionJobRepo } from "@/infra/db/repositories";
import { json, workspaceRoute } from "../../../../../_lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type P = { id: string; docId: string };

export const POST = workspaceRoute<P>({ mutating: true }, async ({ scope, params, requestId }) => {
  if (!canWrite(scope)) throw new DomainError("not_a_member", "Your role cannot modify documents.", 403);
  if (!isUuid(params.docId)) throw notFound("Document");
  const doc = await documentRepo.get(scope, params.docId);
  if (!doc || doc.workspaceId !== scope.workspaceId) throw notFound("Document");
  await ingestionJobRepo.requeue(scope, doc.id);
  after(async () => {
    await processIngestion(ingestDeps(), scope, doc.id);
  });
  return json({ queued: true }, requestId, 202);
});
