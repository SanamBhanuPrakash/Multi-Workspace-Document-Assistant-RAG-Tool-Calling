import { z } from "zod";
import { DomainError, notFound } from "@/core/domain/errors";
import { resolveConfirmation } from "@/core/application/tools/executor";
import { canWrite, isUuid } from "@/core/security/tenant";
import { toolExecutorDeps } from "@/infra/container";
import { json, readJson, workspaceRoute } from "../../../../_lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type P = { id: string; callId: string };
const Body = z.strictObject({ decision: z.enum(["confirm", "decline"]) });

/**
 * Human-in-the-loop release for a tool call that was held because retrieved documents looked hostile.
 * This authenticated, same-origin, member-only endpoint is the ONLY way a held call can run — never model output.
 */
export const POST = workspaceRoute<P>({ mutating: true }, async ({ req, scope, params, requestId }) => {
  if (!canWrite(scope)) throw new DomainError("not_a_member", "Your role cannot approve actions.", 403);
  if (!isUuid(params.callId)) throw notFound("Tool call");
  const { decision } = await readJson(req, Body);
  const res = await resolveConfirmation(toolExecutorDeps(), scope, params.callId, decision);
  if (res.errorCode === "not_found") throw notFound("Tool call");
  return json({ status: res.status, errorCode: res.errorCode ?? null }, requestId);
});
