import "server-only";
import type { LlmEvent, LlmMessage, LlmPort, LlmRequest } from "@/core/ports/providers";
import { ProviderError } from "@/core/domain/errors";
import { fetchWithRetry, sseData } from "../http";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

type Part = { text?: string; functionCall?: { name: string; args?: Record<string, unknown> }; functionResponse?: { name: string; response: Record<string, unknown> } };
type Content = { role: "user" | "model"; parts: Part[] };

const safeJson = (raw: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Neutral messages → Gemini contents. Consecutive tool results collapse into ONE user turn (Gemini requires strict alternation). */
export function toGeminiContents(messages: LlmMessage[]): Content[] {
  const out: Content[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", parts: [{ text: m.text }] });
    else if (m.role === "assistant") {
      const parts: Part[] = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: safeJson(c.rawArgs) } });
      if (parts.length) out.push({ role: "model", parts });
    } else {
      const part: Part = { functionResponse: { name: m.name, response: { content: safeJson(m.text) } } };
      const last = out[out.length - 1];
      if (last?.role === "user" && last.parts.every((p) => p.functionResponse)) last.parts.push(part);
      else out.push({ role: "user", parts: [part] });
    }
  }
  return out;
}

/** Gemini accepts an OpenAPI-3 schema SUBSET: drop keys it rejects. */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "additionalProperties" || k === "$schema" || k === "default" || k === "exclusiveMinimum" || k === "exclusiveMaximum") continue;
    out[k] = toGeminiSchema(v);
  }
  return out;
}

type Chunk = {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  promptFeedback?: { blockReason?: string };
};

export class GeminiLlm implements LlmPort {
  readonly provider = "gemini";
  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async *generate(req: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmEvent> {
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toGeminiContents(req.messages),
      ...(req.tools.length
        ? { tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })) }], toolConfig: { functionCallingConfig: { mode: "AUTO" } } }
        : {}),
      generationConfig: {
        temperature: req.temperature ?? 0.2,
        maxOutputTokens: req.maxOutputTokens ?? 1500,
        thinkingConfig: { thinkingBudget: 0 }, // grounded extraction: latency and determinism over deliberation
      },
    };
    const res = await fetchWithRetry(
      `${BASE}/models/${this.model}:streamGenerateContent?alt=sse`,
      { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey }, body: JSON.stringify(body) },
      { attempts: 2, attemptTimeoutMs: 30_000, deadlineMs: 40_000, ...(signal ? { signal } : {}) },
    );
    if (!res.body) throw new ProviderError("unavailable", "The AI provider returned an empty response.");

    let toolSeq = 0;
    let sawToolCall = false;
    let usage = { tokensIn: 0, tokensOut: 0 };
    let finish: "stop" | "tool_calls" | "length" | "other" = "stop";
    for await (const data of sseData(res.body)) {
      let chunk: Chunk;
      try {
        chunk = JSON.parse(data) as Chunk;
      } catch {
        continue; // ignore keep-alives / partial garbage
      }
      if (chunk.promptFeedback?.blockReason) throw new ProviderError("blocked", "The AI provider declined to process this content.");
      const cand = chunk.candidates?.[0];
      for (const p of cand?.content?.parts ?? []) {
        if (p.text) yield { type: "text", delta: p.text };
        if (p.functionCall) {
          sawToolCall = true;
          yield { type: "tool_call", id: `call_${++toolSeq}`, name: p.functionCall.name, rawArgs: JSON.stringify(p.functionCall.args ?? {}) };
        }
      }
      if (chunk.usageMetadata) usage = { tokensIn: chunk.usageMetadata.promptTokenCount ?? usage.tokensIn, tokensOut: chunk.usageMetadata.candidatesTokenCount ?? usage.tokensOut };
      if (cand?.finishReason) {
        if (cand.finishReason === "MAX_TOKENS") finish = "length";
        else if (cand.finishReason === "SAFETY" || cand.finishReason === "PROHIBITED_CONTENT" || cand.finishReason === "RECITATION") throw new ProviderError("blocked", "The AI provider declined to process this content.");
        else if (cand.finishReason !== "STOP") finish = "other";
      }
    }
    yield { type: "usage", usage };
    yield { type: "done", finishReason: sawToolCall ? "tool_calls" : finish };
  }
}
