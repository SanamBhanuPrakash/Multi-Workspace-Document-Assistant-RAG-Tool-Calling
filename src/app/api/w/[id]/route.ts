import { z } from "zod";
import { DomainError } from "@/core/domain/errors";
import { workspaceRepo } from "@/infra/db/queries";
import { json, readJson, workspaceRoute } from "../../_lib/http";

export const dynamic = "force-dynamic";

const Rename = z.strictObject({ name: z.string().trim().min(1).max(80) });

export const GET = workspaceRoute({}, async ({ scope, requestId }) => json({ workspace: await workspaceRepo.get(scope) }, requestId));

export const PATCH = workspaceRoute({ mutating: true }, async ({ req, scope, requestId }) => {
  if (scope.role !== "owner") throw new DomainError("not_a_member", "Only the workspace owner can rename it.", 403);
  await workspaceRepo.rename(scope, (await readJson(req, Rename)).name);
  return json({ ok: true }, requestId);
});

export const DELETE = workspaceRoute({ mutating: true }, async ({ scope, requestId }) => {
  if (scope.role !== "owner") throw new DomainError("not_a_member", "Only the workspace owner can delete it.", 403);
  return json({ deleted: await workspaceRepo.remove(scope) }, requestId);
});
