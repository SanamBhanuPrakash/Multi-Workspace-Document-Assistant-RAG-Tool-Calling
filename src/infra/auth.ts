import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { env } from "./env";
import { db } from "./db/client";
import * as schema from "./db/schema";
import { rateLimiter } from "./db/repositories";

/**
 * Authentication: Better Auth (maintained library — no hand-rolled password or session code).
 *  - passwords: scrypt (library default), 10–128 chars
 *  - sessions: opaque random token, stored server-side, delivered in an httpOnly / SameSite=Lax cookie
 *    (Secure + `__Secure-` prefix in production); rotates on sign-in; 7-day expiry, refreshed daily
 *  - CSRF/origin: library origin check against trustedOrigins (exactly APP_URL)
 *  - throttling: atomic Postgres counter (shared across serverless instances) — NOT per-instance memory
 */
const isProd = () => env().NODE_ENV === "production";

function build() {
  const e = env();
  return betterAuth({
    appName: "Lattice",
    baseURL: e.APP_URL,
    secret: e.BETTER_AUTH_SECRET,
    trustedOrigins: [e.APP_URL],
    database: drizzleAdapter(db(), { provider: "pg", schema: { user: schema.user, session: schema.session, account: schema.account, verification: schema.verification } }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      autoSignIn: true,
      requireEmailVerification: false, // free tier, no mail provider: documented trade-off (see docs/SECURITY.md)
    },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 120 * e.LATTICE_RATE_LIMIT_SCALE,
      customRules: {
        "/sign-in/email": { window: 60, max: 8 * e.LATTICE_RATE_LIMIT_SCALE },
        "/sign-up/email": { window: 3600, max: 10 * e.LATTICE_RATE_LIMIT_SCALE },
      },
      customStorage: {
        consume: async (key, rule) => {
          const allowed = await rateLimiter.allow(`auth:${key}`, rule.max, rule.window);
          const intoWindow = Math.floor(Date.now() / 1000) % rule.window;
          return { allowed, retryAfter: allowed ? null : rule.window - intoWindow };
        },
      },
    },
    advanced: {
      useSecureCookies: isProd(),
      cookiePrefix: "lattice",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: isProd() },
      ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] },
    },
    plugins: [nextCookies()],
  });
}

type Auth = ReturnType<typeof build>;
const g = globalThis as unknown as { __latticeAuth?: Auth };

export function auth(): Auth {
  g.__latticeAuth ??= build();
  return g.__latticeAuth;
}
