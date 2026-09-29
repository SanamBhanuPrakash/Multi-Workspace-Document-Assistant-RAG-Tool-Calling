import { z } from "zod";
import { DomainError, notFound } from "@/core/domain/errors";
import { canAdminister, isUuid } from "@/core/security/tenant";
import { shareRepo } from "@/infra/db/repositories";
import { json, readJson, workspaceRoute } from "../../../../../_lib/http";

export const dynamic = "force-dynamic";

type P = { id: string; docId: string };
const Body = z.strictObject({ targetWorkspaceId: z.uuid() });

/** Explicit, opt-in, read-only sharing. Requires admin in the source AND membership of the target (also enforced by RLS). */
export const POST = workspaceRoute<P>({ mutating: true }, async ({ req, scope, params, requestId }) => {
  if (!canAdminister(scope)) throw new DomainError("not_a_member", "Only workspace admins can share documents.", 403);
  if (!isUuid(params.docId)) throw notFound("Document");
  const { targetWorkspaceId } = await readJson(req, Body);
  if (targetWorkspaceId === scope.workspaceId) throw new DomainError("validation", "Choose a different workspace.", 422);
  try {
    await shareRepo.grant(scope, params.docId, targetWorkspaceId);
  } catch (err) {
    if (err instanceof Error && err.message === "not_found") throw notFound("Document");
    // A policy violation means the caller is not a member of the target: report it as an ordinary 404 (no existence oracle).
    throw new DomainError("not_found", "Target workspace not found.", 404);
  }
  return json({ shared: true }, requestId, 201);
});

export const DELETE = workspaceRoute<P>({ mutating: true }, async ({ req, scope, params, requestId }) => {
  if (!canAdminister(scope)) throw new DomainError("not_a_member", "Only workspace admins can change sharing.", 403);
  if (!isUuid(params.docId)) throw notFound("Document");
  const { targetWorkspaceId } = await readJson(req, Body);
  await shareRepo.revoke(scope, params.docId, targetWorkspaceId);
  return json({ shared: false }, requestId);
});
