import "server-only";
import type { LlmEvent, LlmMessage, LlmPort, LlmRequest } from "@/core/ports/providers";
import { ProviderError } from "@/core/domain/errors";
import { fetchWithRetry, sseData } from "../http";

const URL_CHAT = "https://api.groq.com/openai/v1/chat/completions";

type OaMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export function toOpenAiMessages(system: string, messages: LlmMessage[]): OaMessage[] {
  const out: OaMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.text || null,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.rawArgs } })) } : {}),
      });
    } else out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.text });
  }
  return out;
}

type Delta = {
  choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  x_groq?: { usage?: { prompt_tokens?: number; completion_tokens?: number } };
};

/** Groq: OpenAI-compatible chat completions. Chat fallback only — Groq offers no embeddings. */
export class GroqLlm implements LlmPort {
  readonly provider = "groq";
  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async *generate(req: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmEvent> {
    yield { type: "meta", provider: this.provider, model: this.model };
    const res = await fetchWithRetry(
      URL_CHAT,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          stream: true,
          stream_options: { include_usage: true },
          temperature: req.temperature ?? 0.2,
          max_completion_tokens: req.maxOutputTokens ?? 1500,
          messages: toOpenAiMessages(req.system, req.messages),
          ...(req.tools.length
            ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: "auto" }
            : {}),
        }),
      },
      { attempts: 3, attemptTimeoutMs: 45_000, deadlineMs: 50_000, ...(signal ? { signal } : {}) },
    );
    if (!res.body) throw new ProviderError("unavailable", "The AI provider returned an empty response.");

    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage = { tokensIn: 0, tokensOut: 0 };
    let finish: "stop" | "tool_calls" | "length" | "other" = "stop";
    for await (const data of sseData(res.body)) {
      if (data === "[DONE]") break;
      let chunk: Delta;
      try {
        chunk = JSON.parse(data) as Delta;
      } catch {
        continue;
      }
      const choice = chunk.choices?.[0];
      const text = choice?.delta?.content;
      if (text) yield { type: "text", delta: text };
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: tc.id ?? `call_${tc.index + 1}`, name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
      const u = chunk.usage ?? chunk.x_groq?.usage;
      if (u) usage = { tokensIn: u.prompt_tokens ?? usage.tokensIn, tokensOut: u.completion_tokens ?? usage.tokensOut };
      if (choice?.finish_reason) finish = choice.finish_reason === "length" ? "length" : choice.finish_reason === "tool_calls" ? "tool_calls" : choice.finish_reason === "stop" ? "stop" : "other";
    }
    for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) yield { type: "tool_call", id: c.id, name: c.name, rawArgs: c.args };
    yield { type: "usage", usage };
    yield { type: "done", finishReason: calls.size ? "tool_calls" : finish };
  }
}
