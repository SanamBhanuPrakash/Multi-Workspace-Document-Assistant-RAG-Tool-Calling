import { z } from "zod";
import { DomainError } from "@/core/domain/errors";
import { canWrite } from "@/core/security/tenant";
import { dashboardQueries } from "@/infra/db/queries";
import { json, readJson, workspaceRoute } from "../../../_lib/http";

export const dynamic = "force-dynamic";

export const GET = workspaceRoute({}, async ({ scope, requestId }) => json({ tasks: await dashboardQueries.tasks(scope) }, requestId));

const Patch = z.strictObject({ taskId: z.uuid(), status: z.enum(["open", "done"]) });

export const PATCH = workspaceRoute({ mutating: true }, async ({ req, scope, requestId }) => {
  if (!canWrite(scope)) throw new DomainError("not_a_member", "Your role cannot edit tasks.", 403);
  const { taskId, status } = await readJson(req, Patch);
  await dashboardQueries.setTaskStatus(scope, taskId, status);
  return json({ ok: true }, requestId);
});
