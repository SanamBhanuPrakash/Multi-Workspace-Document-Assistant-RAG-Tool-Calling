import "server-only";
import type { LlmEvent, LlmPort, LlmRequest } from "@/core/ports/providers";
import { ProviderError } from "@/core/domain/errors";
import { childLogger } from "../logging/logger";

type CooldownKind = "rate_limited" | "unavailable" | "timeout";
export type ChainOptions = {
  /** How long a link that just failed is deprioritised. Request-specific failures (blocked / bad_request) never trigger it. */
  cooldownMs?: Record<CooldownKind, number>;
  /** Injectable clock for tests. */
  now?: () => number;
};
const DEFAULT_COOLDOWN: Record<CooldownKind, number> = { rate_limited: 30_000, unavailable: 15_000, timeout: 15_000 };
const isCooldownKind = (k: string): k is CooldownKind => k === "rate_limited" || k === "unavailable" || k === "timeout";

/**
 * Ordered failover chain (e.g. gemini-3.6 → gemini-3.5 → groq). Free tiers are spiky: one model may be out of quota while its
 * sibling is fine, so we walk the chain.
 *
 * Circuit breaker: a link that just failed (rate limit / outage / timeout) is moved BEHIND the healthy ones for a cooldown, so
 * the next requests do not each pay to re-discover that it is down (measured: ~3.5s per question before this, 40s for the
 * first). Cooling links are never skipped outright — they remain the last resort — so a chain can only get slower to give up,
 * never give up earlier than before.
 *
 * We only fail over when NOTHING has been emitted yet: switching providers mid-stream would splice two different models'
 * outputs (and could repeat a tool call). After the first event, errors propagate to the caller, which marks the reply
 * `failed` and offers a retry.
 */
export class ChainLlm implements LlmPort {
  private readonly openUntil: number[];
  private readonly now: () => number;
  private readonly cooldown: Record<CooldownKind, number>;

  constructor(
    private readonly links: LlmPort[],
    options: ChainOptions = {},
  ) {
    if (links.length === 0) throw new Error("ChainLlm needs at least one provider");
    this.openUntil = links.map(() => 0);
    this.now = options.now ?? Date.now;
    this.cooldown = options.cooldownMs ?? DEFAULT_COOLDOWN;
  }
  get provider(): string {
    return this.links[0]!.provider;
  }
  get model(): string {
    return this.links[0]!.model;
  }

  /** Healthy links in configured priority order, then cooling ones (also in order) as the last resort. */
  private order(): number[] {
    const t = this.now();
    const idx = this.links.map((_, i) => i);
    return [...idx.filter((i) => this.openUntil[i]! <= t), ...idx.filter((i) => this.openUntil[i]! > t)];
  }

  async *generate(req: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmEvent> {
    let lastError: unknown;
    const order = this.order();
    for (const [pos, idx] of order.entries()) {
      const link = this.links[idx]!;
      let emitted = false;
      try {
        for await (const ev of link.generate(req, signal)) {
          if (ev.type !== "meta") emitted = true; // meta is bookkeeping; the consumer keeps the LAST one it sees
          yield ev;
        }
        this.openUntil[idx] = 0; // healthy again
        return;
      } catch (err) {
        lastError = err;
        if (err instanceof ProviderError && isCooldownKind(err.kind)) this.openUntil[idx] = this.now() + this.cooldown[err.kind];
        const nextIdx = order[pos + 1];
        const next = nextIdx === undefined ? undefined : this.links[nextIdx];
        const eligible = !emitted && next && err instanceof ProviderError && (err.retryable || err.kind === "blocked" || err.kind === "bad_request");
        if (!eligible) throw err;
        childLogger({ from: `${link.provider}/${link.model}`, to: `${next.provider}/${next.model}`, reason: err.kind }).warn("llm failover");
      }
    }
    throw lastError;
  }
}
