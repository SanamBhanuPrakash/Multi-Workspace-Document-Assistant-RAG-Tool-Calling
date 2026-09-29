/** Domain errors carry a stable machine `code` (safe to show) and never include secrets or foreign-tenant data. */
export type ErrorCode =
  | "not_a_member"
  | "not_found"
  | "validation"
  | "rate_limited"
  | "payload_too_large"
  | "unsupported_media"
  | "provider_unavailable"
  | "provider_rate_limited"
  | "timeout"
  | "conflict"
  | "internal";

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly httpStatus: number = 400,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DomainError";
  }
}

export const notAMember = () => new DomainError("not_a_member", "You do not have access to this workspace.", 403);
export const notFound = (what = "Resource") => new DomainError("not_found", `${what} not found.`, 404);
