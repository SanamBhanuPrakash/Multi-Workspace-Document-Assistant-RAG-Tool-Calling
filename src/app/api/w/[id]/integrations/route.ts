import { z } from "zod";
import { DomainError } from "@/core/domain/errors";
import { canAdminister } from "@/core/security/tenant";
import { integrationRepo } from "@/infra/db/repositories";
import { json, readJson, workspaceRoute } from "../../../_lib/http";

export const dynamic = "force-dynamic";

const Put = z.strictObject({ kind: z.enum(["slack", "discord"]), url: z.string().min(20).max(400) });
const Del = z.strictObject({ kind: z.enum(["slack", "discord"]) });

/** Only a non-secret hint (host + last 4 chars) is ever returned. The webhook URL itself never leaves the server after saving. */
export const GET = workspaceRoute({}, async ({ scope, requestId }) => json({ integrations: await integrationRepo.list(scope) }, requestId));

export const PUT = workspaceRoute({ mutating: true }, async ({ req, scope, requestId }) => {
  if (!canAdminister(scope)) throw new DomainError("not_a_member", "Only workspace admins can manage integrations.", 403);
  const { kind, url } = await readJson(req, Put);
  return json({ kind, ...(await integrationRepo.save(scope, kind, url)) }, requestId); // validates shape + encrypts (AES-256-GCM)
});

export const DELETE = workspaceRoute({ mutating: true }, async ({ req, scope, requestId }) => {
  if (!canAdminister(scope)) throw new DomainError("not_a_member", "Only workspace admins can manage integrations.", 403);
  await integrationRepo.remove(scope, (await readJson(req, Del)).kind);
  return json({ removed: true }, requestId);
});
