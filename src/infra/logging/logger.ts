import "server-only";
import pino from "pino";

/**
 * Structured logger with aggressive redaction. Secrets must not reach logs even by accident:
 * anything that looks like a key, token, cookie, webhook URL or embedding vector is censored.
 */
const REDACT_PATHS = [
  "*.apiKey", "*.api_key", "*.authorization", "*.cookie", "*.password", "*.token", "*.secret",
  "*.webhookUrl", "*.webhook_url", "*.secretCiphertext", "*.embedding",
  "req.headers.authorization", "req.headers.cookie", "headers.authorization", "headers.cookie",
  "apiKey", "authorization", "cookie", "password", "token", "secret", "webhookUrl", "embedding",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  base: { app: "lattice" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export const childLogger = (bindings: Record<string, string | number | boolean | undefined>) => logger.child(bindings);

const SECRET_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /gsk_[0-9A-Za-z]{20,}/g, // Groq keys
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  /https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g,
  /postgres(?:ql)?:\/\/\S+/g,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/g,
];

/** Strip anything shaped like a credential from free text before it is logged or shown. */
export function scrub(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, "[redacted]");
  return out;
}

const MAX_MESSAGE = 400;

/**
 * Turn an unknown error into something loggable without leaking request bodies or URLs with secrets.
 * Drizzle wraps driver errors as `Failed query: <sql>\nparams: <every bound value>` — the params are document text,
 * vectors, ciphertext. We log the underlying driver error (`cause`) instead and never the wrapper.
 */
export function safeError(err: unknown): { name: string; message: string; code?: string } {
  if (err instanceof Error) {
    const root = err.message.startsWith("Failed query:") && err.cause instanceof Error ? err.cause : err;
    const code = (root as { code?: unknown }).code;
    return {
      name: root.name,
      message: scrub(root.message).slice(0, MAX_MESSAGE),
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return { name: "NonError", message: scrub(String(err)).slice(0, MAX_MESSAGE) };
}
