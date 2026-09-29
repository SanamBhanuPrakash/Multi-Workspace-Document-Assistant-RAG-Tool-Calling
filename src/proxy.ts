import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge-side hardening for PAGE requests (API routes set their own headers).
 *
 *  1. Content-Security-Policy with a fresh nonce per request and 'strict-dynamic': injected markup cannot run script.
 *  2. Optimistic redirect for signed-out visitors. This is a UX optimisation only — Next.js's guidance is explicit that the
 *     proxy is not a security boundary. Real authentication + tenant membership are enforced in the data-access layer
 *     (src/infra/session.ts) on every request.
 */
const SESSION_COOKIES = ["lattice.session_token", "__Secure-lattice.session_token"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const signedIn = SESSION_COOKIES.some((c) => request.cookies.has(c));

  if (!signedIn && (pathname === "/app" || pathname.startsWith("/app/") || pathname.startsWith("/w/"))) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  if (signedIn && (pathname === "/login" || pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/app";
    url.search = "";
    return NextResponse.redirect(url);
  }

  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-inline'" : ""}`,
    "style-src-attr 'unsafe-inline'", // React SSR emits style="" attributes; script execution is what CSP must lock down
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)", missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }] }],
};
