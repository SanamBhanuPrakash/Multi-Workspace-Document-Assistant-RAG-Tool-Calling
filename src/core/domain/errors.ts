/** Domain errors carry a stable machine `code` (safe to show) and never include secrets or foreign-tenant data. */
export type ErrorCode =
  | "unauthenticated"
  | "not_a_member"
  | "not_found"
  | "validation"
  | "rate_limited"
  | "payload_too_large"
  | "unsupported_media"
  | "provider_unavailable"
  | "provider_rate_limited"
  | "provider_blocked"
  | "timeout"
  | "aborted"
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

/** Raised by LLM / embedding adapters. `retryable` drives the "Retry" affordance in the UI. */
export class ProviderError extends Error {
  constructor(
    public readonly kind: "rate_limited" | "unavailable" | "timeout" | "blocked" | "bad_request",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProviderError";
  }
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "unavailable" || this.kind === "timeout";
  }
  get code(): ErrorCode {
    return { rate_limited: "provider_rate_limited", unavailable: "provider_unavailable", timeout: "timeout", blocked: "provider_blocked", bad_request: "provider_unavailable" }[this.kind] as ErrorCode;
  }
}
