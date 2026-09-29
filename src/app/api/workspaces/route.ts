import { z } from "zod";
import { DomainError } from "@/core/domain/errors";
import { rateLimiter } from "@/infra/db/repositories";
import { workspaceRepo } from "@/infra/db/queries";
import { json, readJson, userRoute } from "../_lib/http";

export const dynamic = "force-dynamic";

export const GET = userRoute({}, async ({ user, requestId }) => json({ workspaces: await workspaceRepo.listForUser(user.id) }, requestId));

const Create = z.strictObject({ name: z.string().trim().min(1).max(80) });

export const POST = userRoute({ mutating: true }, async ({ req, user, requestId }) => {
  const { name } = await readJson(req, Create);
  if (!(await rateLimiter.allow(`ws-create:${user.id}`, 10, 3600))) throw new DomainError("rate_limited", "You are creating workspaces too quickly.", 429);
  const existing = await workspaceRepo.listForUser(user.id);
  if (existing.length >= 20) throw new DomainError("conflict", "Workspace limit reached (20).", 409);
  return json({ workspace: await workspaceRepo.create(user.id, name) }, requestId, 201);
});
