import { describe, expect, it } from "vitest";
import { ProviderError } from "@/core/domain/errors";
import type { LlmEvent, LlmPort, LlmRequest } from "@/core/ports/providers";
import { ChainLlm } from "@/infra/llm/fallback";

const REQ: LlmRequest = { system: "s", messages: [{ role: "user", text: "hi" }], tools: [] };
const text = (t: string): LlmEvent[] => [{ type: "text", delta: t }, { type: "usage", usage: { tokensIn: 1, tokensOut: 1 } }, { type: "done", finishReason: "stop" }];

/** A link whose behaviour is a script: return events, throw before emitting, or emit then throw. */
class Link implements LlmPort {
  calls = 0;
  constructor(
    readonly provider: string,
    readonly model: string,
    private readonly behave: (call: number) => { events?: LlmEvent[]; throwBefore?: unknown; throwAfter?: unknown },
  ) {}
  async *generate(): AsyncGenerator<LlmEvent> {
    const b = this.behave(++this.calls);
    yield { type: "meta", provider: this.provider, model: this.model };
    if (b.throwBefore) throw b.throwBefore;
    for (const ev of b.events ?? []) yield ev;
    if (b.throwAfter) throw b.throwAfter;
  }
}
const ok = (name: string, reply = name) => new Link(name, `${name}-m`, () => ({ events: text(reply) }));
const failing = (name: string, kind: ProviderError["kind"]) => new Link(name, `${name}-m`, () => ({ throwBefore: new ProviderError(kind, `${name} ${kind}`) }));
const collect = async (chain: LlmPort) => {
  const out: LlmEvent[] = [];
  for await (const e of chain.generate(REQ)) out.push(e);
  return out;
};
const replyOf = (evs: LlmEvent[]) => evs.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
const lastMeta = (evs: LlmEvent[]) => [...evs].reverse().find((e) => e.type === "meta") as { provider: string } | undefined;

describe("ChainLlm — failover", () => {
  it("uses the first link when it works", async () => {
    const a = ok("a"), b = ok("b");
    expect(replyOf(await collect(new ChainLlm([a, b])))).toBe("a");
    expect(b.calls).toBe(0);
  });

  it("fails over on retryable errors (rate limit / unavailable / timeout) and reports who actually answered", async () => {
    for (const kind of ["rate_limited", "unavailable", "timeout"] as const) {
      const evs = await collect(new ChainLlm([failing("a", kind), ok("b")]));
      expect(replyOf(evs)).toBe("b");
      expect(lastMeta(evs)!.provider).toBe("b");
    }
  });

  it("also fails over on a content-specific block or a rejected request (another model may accept it)", async () => {
    for (const kind of ["blocked", "bad_request"] as const) {
      expect(replyOf(await collect(new ChainLlm([failing("a", kind), ok("b")])))).toBe("b");
    }
  });

  it("walks the whole chain in order", async () => {
    const a = failing("a", "rate_limited"), b = failing("b", "unavailable"), c = ok("c");
    expect(replyOf(await collect(new ChainLlm([a, b, c])))).toBe("c");
    expect([a.calls, b.calls, c.calls]).toEqual([1, 1, 1]);
  });

  it("when every link fails, the LAST error reaches the caller (typed, retryable => the UI offers Retry)", async () => {
    const err = await collect(new ChainLlm([failing("a", "rate_limited"), failing("b", "timeout")])).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("timeout");
  });

  it("NEVER fails over after output has started: splicing two models (or repeating a tool call) is worse than an error", async () => {
    const a = new Link("a", "a-m", () => ({ events: [{ type: "text", delta: "partial " }], throwAfter: new ProviderError("unavailable", "died mid-stream") }));
    const b = ok("b");
    const seen: LlmEvent[] = [];
    const err = await (async () => {
      try {
        for await (const e of new ChainLlm([a, b]).generate(REQ)) seen.push(e);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ProviderError);
    expect(replyOf(seen)).toBe("partial ");
    expect(b.calls).toBe(0);
  });

  it("does not swallow programming errors: a non-ProviderError propagates instead of being papered over by a fallback", async () => {
    const a = new Link("a", "a-m", () => ({ throwBefore: new TypeError("bug") }));
    const b = ok("b");
    await expect(collect(new ChainLlm([a, b]))).rejects.toThrow("bug");
    expect(b.calls).toBe(0);
  });

  it("a chain needs at least one link", () => {
    expect(() => new ChainLlm([])).toThrow();
  });
});

describe("ChainLlm — cooldown (circuit breaker)", () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => void (t += ms) };
  };

  it("after a rate limit, later requests skip that link instead of re-probing it (no per-request latency tax)", async () => {
    const c = clock();
    const a = failing("a", "rate_limited"), b = ok("b");
    const chain = new ChainLlm([a, b], { now: c.now, cooldownMs: { rate_limited: 30_000, unavailable: 10_000, timeout: 10_000 } });
    await collect(chain);
    await collect(chain);
    await collect(chain);
    expect(a.calls).toBe(1); // probed once, then skipped
    expect(b.calls).toBe(3);
  });

  it("probes the link again once its cooldown has elapsed, and a success closes the breaker", async () => {
    const c = clock();
    let healthy = false;
    const a = new Link("a", "a-m", () => (healthy ? { events: text("a") } : { throwBefore: new ProviderError("rate_limited", "429") }));
    const b = ok("b");
    const chain = new ChainLlm([a, b], { now: c.now, cooldownMs: { rate_limited: 30_000, unavailable: 10_000, timeout: 10_000 } });
    await collect(chain); // a fails, cooldown starts
    c.advance(29_000);
    await collect(chain);
    expect(a.calls).toBe(1); // still cooling
    healthy = true;
    c.advance(2_000); // cooldown over
    expect(replyOf(await collect(chain))).toBe("a");
    expect(a.calls).toBe(2);
    expect(replyOf(await collect(chain))).toBe("a"); // breaker closed: a is primary again
  });

  it("different failure kinds get different cooldowns", async () => {
    const c = clock();
    const a = failing("a", "unavailable"), b = ok("b");
    const chain = new ChainLlm([a, b], { now: c.now, cooldownMs: { rate_limited: 60_000, unavailable: 5_000, timeout: 5_000 } });
    await collect(chain);
    c.advance(6_000);
    await collect(chain);
    expect(a.calls).toBe(2);
  });

  it("request-specific failures (blocked / bad_request) do NOT put a healthy model into cooldown", async () => {
    const c = clock();
    const a = failing("a", "blocked"), b = ok("b");
    const chain = new ChainLlm([a, b], { now: c.now });
    await collect(chain);
    await collect(chain);
    expect(a.calls).toBe(2); // tried for every request: one bad prompt says nothing about the model's health
  });

  it("cooling links are still the LAST RESORT: if everything else fails, they are tried rather than giving up", async () => {
    const c = clock();
    let bUp = true;
    const a = new Link("a", "a-m", (n) => (n === 1 ? { throwBefore: new ProviderError("rate_limited", "429") } : { events: text("a-recovered") }));
    const b = new Link("b", "b-m", () => (bUp ? { events: text("b") } : { throwBefore: new ProviderError("unavailable", "down") }));
    const chain = new ChainLlm([a, b], { now: c.now, cooldownMs: { rate_limited: 60_000, unavailable: 60_000, timeout: 60_000 } });
    await collect(chain); // a cools down, b answers
    bUp = false;
    expect(replyOf(await collect(chain))).toBe("a-recovered"); // b failed, so the cooling a was tried as a last resort
  });

  it("ordering: healthy links keep their configured priority; cooling ones move behind them", async () => {
    const c = clock();
    const a = failing("a", "rate_limited"), b = failing("b", "rate_limited"), d = ok("d");
    const chain = new ChainLlm([a, b, d], { now: c.now, cooldownMs: { rate_limited: 30_000, unavailable: 30_000, timeout: 30_000 } });
    await collect(chain);
    await collect(chain);
    expect([a.calls, b.calls, d.calls]).toEqual([1, 1, 2]);
  });
});
