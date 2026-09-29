import "server-only";
import { ProviderError } from "@/core/domain/errors";

/**
 * Resilient outbound HTTP for provider calls.
 *  - hard per-attempt timeout and an overall deadline (so a slow provider can never hang a request)
 *  - retry ONLY transient failures (429, 5xx, network) with full-jitter exponential backoff, honouring Retry-After
 *  - never retries 4xx client errors (a bad request stays bad) and never logs headers or bodies (they carry keys/content)
 *  - errors are typed ProviderError with a user-safe message; the upstream response body is NOT copied into it
 */
export type RetryOptions = {
  attempts?: number;
  attemptTimeoutMs?: number;
  deadlineMs?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 20_000);
  const date = Date.parse(h);
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 0), 20_000) : null;
}

export function classifyStatus(status: number): ProviderError["kind"] | null {
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "unavailable";
  if (status === 401 || status === 403) return "unavailable"; // bad/expired key is an operator problem, not a user one
  if (status >= 400) return "bad_request";
  return null;
}

const PUBLIC_MESSAGES: Record<ProviderError["kind"], string> = {
  rate_limited: "The AI provider is rate-limiting requests right now.",
  unavailable: "The AI provider is temporarily unavailable.",
  timeout: "The AI provider took too long to respond.",
  blocked: "The AI provider declined to process this content.",
  bad_request: "The AI provider rejected the request.",
};

export async function fetchWithRetry(url: string, init: RequestInit, opts: RetryOptions = {}): Promise<Response> {
  const attempts = opts.attempts ?? 4;
  const attemptTimeout = opts.attemptTimeoutMs ?? 30_000;
  const started = Date.now();
  const deadline = opts.deadlineMs ?? 60_000;
  const sleep = opts.sleep ?? defaultSleep;
  const doFetch = opts.fetchImpl ?? fetch;
  let lastKind: ProviderError["kind"] = "unavailable";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted) throw new ProviderError("timeout", "Request cancelled.");
    const signals = [AbortSignal.timeout(attemptTimeout), ...(opts.signal ? [opts.signal] : [])];
    let wait: number | null = null;
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.any(signals) });
      const kind = classifyStatus(res.status);
      if (!kind) return res;
      lastKind = kind;
      // Drain and discard the body: it may echo the request (and therefore content or keys).
      await res.body?.cancel().catch(() => undefined);
      if (kind !== "rate_limited" && kind !== "unavailable" && kind !== "timeout") throw new ProviderError(kind, PUBLIC_MESSAGES[kind]);
      if (res.status === 401 || res.status === 403) throw new ProviderError("unavailable", PUBLIC_MESSAGES.unavailable); // retrying a bad key is pointless
      wait = retryAfterMs(res);
    } catch (err) {
      if (err instanceof ProviderError) {
        if (!err.retryable) throw err;
        lastKind = err.kind;
      } else if (opts.signal?.aborted) {
        throw new ProviderError("timeout", "Request cancelled.");
      } else {
        lastKind = err instanceof DOMException && err.name === "TimeoutError" ? "timeout" : "unavailable";
      }
    }
    if (attempt === attempts) break;
    const backoff = wait ?? Math.random() * Math.min(8_000, (opts.baseDelayMs ?? 500) * 2 ** (attempt - 1)); // full jitter
    if (Date.now() - started + backoff > deadline) break;
    await sleep(backoff);
  }
  throw new ProviderError(lastKind, PUBLIC_MESSAGES[lastKind]);
}

/** Parse a Server-Sent-Events body into `data:` payload strings. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
        const data = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (data) yield data;
      }
    }
    const tail = buf.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
