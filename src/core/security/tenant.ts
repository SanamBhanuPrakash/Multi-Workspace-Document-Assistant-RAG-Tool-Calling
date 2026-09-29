import { notAMember } from "../domain/errors";

export type Role = "owner" | "admin" | "member" | "viewer";

declare const tenantBrand: unique symbol;

/**
 * Proof that `userId` was verified as a member of `workspaceId`.
 *
 * The brand makes this type unforgeable from normal code: the only producer is `resolveTenantScope`. Every port that
 * touches tenant data takes a TenantScope as its first argument, so it is a compile error to query the shared vector
 * store without having gone through the membership check. Nothing derived from model output can construct one.
 */
export type TenantScope = Readonly<{
  userId: string;
  workspaceId: string;
  role: Role;
  readonly [tenantBrand]: true;
}>;

export interface MembershipLookup {
  /** Returns the caller's role in the workspace, or null if not a member. Must not distinguish "no such workspace". */
  roleOf(userId: string, workspaceId: string): Promise<Role | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export async function resolveTenantScope(lookup: MembershipLookup, userId: string, workspaceId: string): Promise<TenantScope> {
  // Same error for malformed, unknown, and foreign workspace ids: no existence oracle.
  if (!userId || !isUuid(workspaceId)) throw notAMember();
  const role = await lookup.roleOf(userId, workspaceId);
  if (!role) throw notAMember();
  return Object.freeze({ userId, workspaceId, role }) as TenantScope;
}

const WRITE_ROLES: readonly Role[] = ["owner", "admin", "member"];
export const canWrite = (s: TenantScope) => WRITE_ROLES.includes(s.role);
export const canAdminister = (s: TenantScope) => s.role === "owner" || s.role === "admin";
