import "server-only";
import type { LlmEvent, LlmPort, LlmRequest } from "@/core/ports/providers";
import { ProviderError } from "@/core/domain/errors";
import { childLogger } from "../logging/logger";

/**
 * Ordered failover chain (e.g. gemini-3.6 → gemini-3.5 → groq → gemini-lite). Free tiers are spiky: one model may be out
 * of quota while its sibling is fine, so we walk the chain.
 *
 * We only fail over when NOTHING has been emitted yet: switching providers mid-stream would splice two different models'
 * outputs (and could repeat a tool call). After the first event, errors propagate to the caller, which marks the reply
 * `failed` and offers a retry.
 */
export class ChainLlm implements LlmPort {
  /** Which link actually served the most recent call (surfaced in request traces). */
  lastServedBy = "";
  lastModel = "";

  constructor(private readonly links: LlmPort[]) {
    if (links.length === 0) throw new Error("ChainLlm needs at least one provider");
  }
  get provider(): string {
    return this.links[0]!.provider;
  }
  get model(): string {
    return this.links[0]!.model;
  }

  async *generate(req: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmEvent> {
    let lastError: unknown;
    for (const [i, link] of this.links.entries()) {
      let emitted = false;
      try {
        this.lastServedBy = link.provider;
        this.lastModel = link.model;
        for await (const ev of link.generate(req, signal)) {
          emitted = true;
          yield ev;
        }
        return;
      } catch (err) {
        lastError = err;
        const next = this.links[i + 1];
        const eligible = !emitted && next && err instanceof ProviderError && (err.retryable || err.kind === "blocked" || err.kind === "bad_request");
        if (!eligible) throw err;
        childLogger({ from: `${link.provider}/${link.model}`, to: `${next.provider}/${next.model}`, reason: err.kind }).warn("llm failover");
      }
    }
    throw lastError;
  }
}
