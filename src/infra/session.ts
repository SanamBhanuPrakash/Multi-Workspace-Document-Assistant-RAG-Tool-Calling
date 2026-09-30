import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { DomainError } from "@/core/domain/errors";
import { resolveTenantScope, type TenantScope } from "@/core/security/tenant";
import { auth } from "./auth";
import { membershipLookup } from "./db/repositories";

/**
 * Data-access-layer authentication (Next.js guidance: never rely on the proxy/middleware alone — it is an optimisation,
 * not a security boundary). Every server component, action and route handler goes through one of these.
 */
export type SessionUser = { id: string; name: string; email: string };

export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const s = await auth().api.getSession({ headers: await headers() });
  return s ? { id: s.user.id, name: s.user.name, email: s.user.email } : null;
});

/** For pages: unauthenticated visitors are redirected to sign-in. */
export async function requireUser(): Promise<SessionUser> {
  const u = await getSessionUser();
  if (!u) redirect("/login");
  return u;
}

/** For pages under /w/[workspaceId]: membership is verified on EVERY request. A non-member sees a plain 404 (no existence oracle). */
export async function requireWorkspaceScope(workspaceId: string): Promise<{ user: SessionUser; scope: TenantScope }> {
  const user = await requireUser();
  try {
    return { user, scope: await resolveTenantScope(membershipLookup, user.id, workspaceId) };
  } catch (err) {
    if (err instanceof DomainError && err.code === "not_a_member") notFound();
    throw err;
  }
}

/** For route handlers: throws DomainError instead of redirecting. */
export async function apiUser(req: Request): Promise<SessionUser> {
  const s = await auth().api.getSession({ headers: req.headers });
  if (!s) throw new DomainError("unauthenticated", "Sign in required.", 401);
  return { id: s.user.id, name: s.user.name, email: s.user.email };
}

export async function apiScope(req: Request, workspaceId: string): Promise<{ user: SessionUser; scope: TenantScope }> {
  const user = await apiUser(req);
  return { user, scope: await resolveTenantScope(membershipLookup, user.id, workspaceId) };
}
