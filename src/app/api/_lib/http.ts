import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type z } from "zod";
import { DomainError, ProviderError } from "@/core/domain/errors";
import { env } from "@/infra/env";
import { logger, safeError } from "@/infra/logging/logger";
import { apiScope, apiUser, type SessionUser } from "@/infra/session";
import type { TenantScope } from "@/core/security/tenant";

/**
 * Every route handler is built with these wrappers so they all share the same guarantees:
 *  - a request id (returned in `x-request-id` and in every error body, and present in every log line)
 *  - mutations must come from our own origin (defence in depth on top of SameSite=Lax cookies)
 *  - authentication + tenant resolution happen BEFORE the handler; the handler receives a verified TenantScope
 *  - uniform error envelope; unexpected errors never leak internals (the detail goes to the log, keyed by request id)
 *  - bounded body parsing
 */
type Params = Record<string, string>;
export type BaseCtx<P extends Params> = { req: NextRequest; params: P; requestId: string };
export type UserCtx<P extends Params> = BaseCtx<P> & { user: SessionUser };
export type WorkspaceCtx<P extends Params> = UserCtx<P> & { scope: TenantScope };

const SECURITY_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;

export function assertSameOrigin(req: Request): void {
  const expected = new URL(env().APP_URL).origin;
  const origin = req.headers.get("origin");
  if (origin) {
    if (origin !== expected) throw new DomainError("not_a_member", "Cross-origin request refused.", 403);
    return;
  }
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new DomainError("not_a_member", "Cross-site request refused.", 403);
}

export function errorResponse(err: unknown, requestId: string): NextResponse {
  let status = 500;
  let code = "internal";
  let message = "Something went wrong. Please try again.";
  if (err instanceof DomainError) {
    status = err.httpStatus;
    code = err.code;
    message = err.message;
  } else if (err instanceof ProviderError) {
    status = err.kind === "rate_limited" ? 429 : 502;
    code = err.code;
    message = err.message;
  } else if (err instanceof ZodError) {
    status = 422;
    code = "validation";
    message = err.issues.slice(0, 3).map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
  } else {
    logger.error({ requestId, err: safeError(err) }, "unhandled route error");
  }
  return NextResponse.json({ error: { code, message, requestId } }, { status, headers: { ...SECURITY_HEADERS, "x-request-id": requestId } });
}

export function json(data: unknown, requestId: string, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { ...SECURITY_HEADERS, "x-request-id": requestId } });
}

type RouteContext<P extends Params> = { params: Promise<P> };

function wrap<P extends Params, C extends BaseCtx<P>>(mutating: boolean, build: (base: BaseCtx<P>) => Promise<C>, handler: (ctx: C) => Promise<Response>) {
  return async (req: NextRequest, rc: RouteContext<P>): Promise<Response> => {
    const requestId = req.headers.get("x-request-id")?.slice(0, 64) || crypto.randomUUID();
    try {
      if (mutating) assertSameOrigin(req);
      const base: BaseCtx<P> = { req, params: await rc.params, requestId };
      const res = await handler(await build(base));
      res.headers.set("x-request-id", requestId);
      return res;
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

export const publicRoute = <P extends Params = Params>(opts: { mutating?: boolean }, h: (c: BaseCtx<P>) => Promise<Response>) =>
  wrap<P, BaseCtx<P>>(opts.mutating ?? false, async (b) => b, h);

export const userRoute = <P extends Params = Params>(opts: { mutating?: boolean }, h: (c: UserCtx<P>) => Promise<Response>) =>
  wrap<P, UserCtx<P>>(opts.mutating ?? false, async (b) => ({ ...b, user: await apiUser(b.req) }), h);

/** The workspace id comes from the URL and is VERIFIED against membership before the handler runs. */
export const workspaceRoute = <P extends Params & { id: string } = { id: string }>(opts: { mutating?: boolean }, h: (c: WorkspaceCtx<P>) => Promise<Response>) =>
  wrap<P, WorkspaceCtx<P>>(opts.mutating ?? false, async (b) => ({ ...b, ...(await apiScope(b.req, b.params.id)) }), h);

/** Bounded JSON body parsing: rejects oversize, non-JSON, and schema violations with 4xx (never 500). */
export async function readJson<S extends z.ZodType>(req: Request, schema: S, maxBytes = 32_768): Promise<z.output<S>> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new DomainError("payload_too_large", "Request body too large.", 413);
  const text = await req.text();
  if (text.length > maxBytes) throw new DomainError("payload_too_large", "Request body too large.", 413);
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new DomainError("validation", "Body must be valid JSON.", 422);
  }
  return schema.parse(raw);
}
