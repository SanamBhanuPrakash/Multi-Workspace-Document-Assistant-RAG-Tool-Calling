import { describe, expect, it } from "vitest";
import { ProviderError } from "@/core/domain/errors";
import { fetchWithRetry } from "@/infra/http";

/**
 * A scripted fetch: each call consumes the next step. Responses are described by a FACTORY so every call gets a fresh body —
 * cloning would tee the stream, and cancelling one branch of a tee never resolves (a test artifact, not real fetch behaviour).
 */
type Step = (() => Response) | Error;
const script = (...steps: Step[]) => {
  const calls: RequestInit[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    return step();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};
const res = (status: number, headers: Record<string, string> = {}, body = "{}"): Step => () => new Response(body, { status, headers });
const sleeps: number[] = [];
const sleep = async (ms: number) => void sleeps.push(ms);
const run = (steps: Parameters<typeof script>, opts: Parameters<typeof fetchWithRetry>[2] = {}) => {
  sleeps.length = 0;
  const s = script(...steps);
  return { s, promise: fetchWithRetry("https://provider.test/x", { method: "POST" }, { sleep, fetchImpl: s.fetchImpl, ...opts }) };
};

describe("fetchWithRetry", () => {
  it("returns a successful response without retrying", async () => {
    const { s, promise } = run([res(200)]);
    expect((await promise).status).toBe(200);
    expect(s.calls).toHaveLength(1);
  });

  it("retries transient failures (429, 503, 504, network) and then succeeds", async () => {
    const { s, promise } = run([res(429), res(503), new TypeError("fetch failed"), res(200)], { attempts: 4 });
    expect((await promise).status).toBe(200);
    expect(s.calls).toHaveLength(4);
  });

  it("does NOT retry client errors: a bad request stays bad", async () => {
    const { s, promise } = run([res(400), res(200)]);
    await expect(promise).rejects.toMatchObject({ name: "ProviderError", kind: "bad_request" });
    expect(s.calls).toHaveLength(1);
  });

  it("does NOT retry 401/403: a bad key is an operator problem, retrying only burns quota", async () => {
    for (const status of [401, 403]) {
      const { s, promise } = run([res(status), res(200)]);
      await expect(promise).rejects.toMatchObject({ kind: "unavailable" });
      expect(s.calls).toHaveLength(1);
    }
  });

  it("gives up after `attempts` and reports the LAST failure kind with a user-safe message", async () => {
    const { s, promise } = run([res(503), res(429)], { attempts: 2 });
    const err = (await promise.then(() => null, (e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("rate_limited");
    expect(err.retryable).toBe(true);
    expect(s.calls).toHaveLength(2);
  });

  it("honours a numeric Retry-After instead of guessing a backoff", async () => {
    const { promise } = run([res(429, { "retry-after": "3" }), res(200)]);
    await promise;
    expect(sleeps).toEqual([3000]);
  });

  it("caps an absurd Retry-After at 20s", async () => {
    const { promise } = run([res(429, { "retry-after": "9999" }), res(200)], { deadlineMs: 60_000 });
    await promise;
    expect(sleeps).toEqual([20_000]);
  });

  it("uses full-jitter exponential backoff when there is no Retry-After (bounded by the cap)", async () => {
    const { promise } = run([res(503), res(503), res(503), res(200)], { attempts: 4, baseDelayMs: 500 });
    await promise;
    expect(sleeps).toHaveLength(3);
    sleeps.forEach((ms, i) => {
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(Math.min(8000, 500 * 2 ** i));
    });
  });

  it("stops retrying when the next wait would blow the overall deadline", async () => {
    const { s, promise } = run([res(429, { "retry-after": "15" }), res(200)], { deadlineMs: 5_000 });
    await expect(promise).rejects.toMatchObject({ kind: "rate_limited" });
    expect(s.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("a hung provider cannot hang the request: the per-attempt timeout fires and is classified as a timeout", async () => {
    const hang = () => new Promise<Response>(() => undefined);
    // fetchImpl must honour the abort signal like real fetch does.
    const fetchImpl = ((_u: string, init: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init.signal!.addEventListener("abort", () => rej(init.signal!.reason));
        void hang;
      })) as unknown as typeof fetch;
    const started = Date.now();
    const err = (await fetchWithRetry("https://provider.test/x", {}, { attempts: 1, attemptTimeoutMs: 50, fetchImpl, sleep }).then(() => null, (e: unknown) => e)) as ProviderError;
    expect(err).toMatchObject({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("cancelling the caller's signal stops immediately (no further attempts)", async () => {
    const ac = new AbortController();
    ac.abort();
    const { s, promise } = run([res(200)], { signal: ac.signal });
    await expect(promise).rejects.toMatchObject({ kind: "timeout" });
    expect(s.calls).toHaveLength(0);
  });

  it("NEVER copies the upstream body (which may echo the prompt or a key) into the error", async () => {
    const leaky = res(400, {}, JSON.stringify({ error: { message: "bad key sk-SECRET-KEY-12345 for prompt: my confidential document text" } }));
    const { promise } = run([leaky]);
    const err = (await promise.then(() => null, (e: unknown) => e)) as Error;
    expect(err.message).not.toContain("SECRET");
    expect(err.message).not.toContain("confidential");
    expect(JSON.stringify(err)).not.toContain("SECRET");
  });

  it("FAIL FAST: a Retry-After longer than maxRetryAfterMs is not slept on — the caller has a fallback and should use it now", async () => {
    const { s, promise } = run([res(429, { "retry-after": "12" }), res(200)], { maxRetryAfterMs: 2_000 });
    const err = (await promise.then(() => null, (e: unknown) => e)) as ProviderError;
    expect(err).toMatchObject({ kind: "rate_limited" });
    expect(s.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("a Retry-After within maxRetryAfterMs is still honoured", async () => {
    const { promise } = run([res(429, { "retry-after": "1" }), res(200)], { maxRetryAfterMs: 2_000 });
    expect((await promise).status).toBe(200);
    expect(sleeps).toEqual([1000]);
  });
});
