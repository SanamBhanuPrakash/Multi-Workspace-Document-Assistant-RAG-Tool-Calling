import type { LlmEvent, LlmPort, LlmRequest } from "@/core/ports/providers";
import { QUESTION_MARKER } from "@/core/security/fence";
import { tokenize } from "../embed/fake";

/**
 * Deterministic OFFLINE model for local development, demos without a key, and browser E2E tests. It is NOT gullible:
 * tool triggers are read from the USER's question only, never from source text — the opposite of the hostile test model
 * used in the injection suite. Refused in production by env.ts.
 */

const SOURCE_RE = /<<<SOURCE-([0-9a-f]+) n=(\d+) title="([^"]*)" section="([^"]*)">>>\n([\s\S]*?)\n<<<END-SOURCE-\1>>>/g;

function words(text: string): AsyncGenerator<LlmEvent> {
  return (async function* () {
    for (const w of text.split(/(?<=\s)/)) yield { type: "text", delta: w };
  })();
}

export class OfflineLlm implements LlmPort {
  readonly provider = "offline";
  readonly model = "offline-extractive";

  async *generate(req: LlmRequest): AsyncGenerator<LlmEvent> {
    yield { type: "meta", provider: this.provider, model: this.model };
    const last = req.messages[req.messages.length - 1];
    let text: string;
    let toolCall: { name: string; args: unknown } | null = null;

    if (last?.role === "tool") {
      const r = JSON.parse(last.text) as { ok: boolean; pending?: boolean; result?: { title?: string; found?: number; delivered?: boolean; count?: number }; error?: { message?: string } };
      text = r.ok
        ? `STATUS: ANSWERED\n\nDone. ${r.result?.title ? `Saved task "${r.result.title}".` : r.result?.delivered ? "Summary delivered." : r.result?.count !== undefined ? `You have ${r.result.count} matching task(s).` : "Completed."}`
        : r.pending
          ? "STATUS: ANSWERED\n\nThat action is waiting for your confirmation before it runs."
          : `STATUS: ANSWERED\n\nI could not do that: ${r.error?.message ?? "the action failed"}.`;
    } else {
      const raw = last && last.role === "user" ? last.text : "";
      const qIdx = raw.lastIndexOf(QUESTION_MARKER);
      const question = (qIdx >= 0 ? raw.slice(qIdx + QUESTION_MARKER.length) : raw).trim();
      const ctx = qIdx >= 0 ? raw.slice(0, qIdx) : "";
      const names = new Set(req.tools.map((t) => t.name));

      const task = /\bsave (?:a |this )?task(?: to)?[:\s-]+(.{3,200})/i.exec(question);
      const send = /\bsend (?:a |the )?summary to (slack|discord)\b/i.exec(question);
      if (task && names.has("save_task")) toolCall = { name: "save_task", args: { title: task[1]!.trim().replace(/[.!]+$/, "") } };
      else if (send && names.has("send_summary")) toolCall = { name: "send_summary", args: { channel: send[1]!.toLowerCase(), title: "Workspace summary", summary: `Summary requested: ${question.slice(0, 200)}` } };

      if (toolCall) text = "";
      else {
        const qTokens = new Set(tokenize(question));
        let best: { n: number; sentence: string; score: number } | null = null;
        for (const m of ctx.matchAll(SOURCE_RE)) {
          for (const sentence of m[5]!.split(/(?<=[.!?])\s+/)) {
            const hit = tokenize(sentence).filter((t) => qTokens.has(t)).length;
            if (hit > (best?.score ?? 0)) best = { n: Number(m[2]), sentence: sentence.trim(), score: hit };
          }
        }
        text = best && best.score >= Math.min(2, qTokens.size)
          ? `STATUS: ANSWERED\n\n${best.sentence} [${best.n}]`
          : "STATUS: NOT_IN_DOCUMENTS\n\nI don't know — this workspace's documents don't contain that.";
      }
    }

    if (toolCall) yield { type: "tool_call", id: "call_1", name: toolCall.name, rawArgs: JSON.stringify(toolCall.args) };
    else yield* words(text);
    yield { type: "usage", usage: { tokensIn: Math.ceil(req.messages.reduce((n, m) => n + (m.role === "assistant" ? m.text.length : m.text.length), 0) / 4), tokensOut: Math.ceil(text.length / 4) } };
    yield { type: "done", finishReason: toolCall ? "tool_calls" : "stop" };
  }
}
