import { DomainError, notFound } from "@/core/domain/errors";
import { canWrite, isUuid } from "@/core/security/tenant";
import { documentRepo } from "@/infra/db/repositories";
import { json, workspaceRoute } from "../../../../_lib/http";

export const dynamic = "force-dynamic";

type P = { id: string; docId: string };

export const DELETE = workspaceRoute<P>({ mutating: true }, async ({ scope, params, requestId }) => {
  if (!canWrite(scope)) throw new DomainError("not_a_member", "Your role cannot delete documents.", 403);
  if (!isUuid(params.docId)) throw notFound("Document");
  // Only documents OWNED by this workspace can be deleted; shared-in documents belong to their source workspace.
  if (!(await documentRepo.delete(scope, params.docId))) throw notFound("Document");
  return json({ deleted: true }, requestId);
});
