/**
 * Live provider smoke test (uses the real API keys from .env). Prints results only — never keys.
 * usage: npx tsx --conditions=react-server --env-file=.env scripts/smoke-live.ts
 */
import { env } from "../src/infra/env";
import { GeminiEmbedding } from "../src/infra/embed/gemini";
import { GeminiLlm } from "../src/infra/llm/gemini";
import { GroqLlm } from "../src/infra/llm/groq";
import { defaultTools } from "../src/core/application/tools/registry";
import type { LlmEvent, LlmPort } from "../src/core/ports/providers";

const e = env();
const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

async function collect(llm: LlmPort, req: Parameters<LlmPort["generate"]>[0]) {
  const t0 = Date.now();
  let text = "";
  const calls: { name: string; rawArgs: string }[] = [];
  let usage: unknown = null;
  let first = 0;
  for await (const ev of llm.generate(req) as AsyncIterable<LlmEvent>) {
    if (ev.type === "text") { if (!first) first = Date.now() - t0; text += ev.delta; }
    if (ev.type === "tool_call") calls.push({ name: ev.name, rawArgs: ev.rawArgs });
    if (ev.type === "usage") usage = ev.usage;
  }
  return { text: text.trim().slice(0, 200), calls, usage, firstTokenMs: first, totalMs: Date.now() - t0 };
}

async function main() {
  const emb = new GeminiEmbedding(e.GEMINI_API_KEY!, e.GEMINI_EMBED_MODEL);
  const t0 = Date.now();
  const [a, b, c] = await emb.embed(["What is the refund window for digital goods?", "Customers may request a refund within 14 days of delivery.", "The quarterly gardening club meets on Tuesdays."], "document");
  console.warn("embed", { dims: a!.length, norm: Math.sqrt(cos(a!, a!)).toFixed(4), related: cos(a!, b!).toFixed(3), unrelated: cos(a!, c!).toFixed(3), ms: Date.now() - t0 });
  const [q] = await emb.embed(["refund window"], "query");
  console.warn("query-vs-doc", { related: cos(q!, b!).toFixed(3), unrelated: cos(q!, c!).toFixed(3) });

  const tools = defaultTools().declarations();
  const plain = { system: "Reply in one short sentence.", messages: [{ role: "user" as const, text: "Say hello and name one fruit." }], tools: [] };
  const toolReq = { system: "You may call tools when the user asks for an action.", messages: [{ role: "user" as const, text: "Please save a task to renew the vault code by 2026-12-01, high priority." }], tools };

  const gem = new GeminiLlm(e.GEMINI_API_KEY!, e.GEMINI_CHAT_MODEL);
  console.warn("model", e.GEMINI_CHAT_MODEL);
  console.warn("gemini text", await collect(gem, plain));
  console.warn("gemini tool", await collect(gem, toolReq));

  if (e.GROQ_API_KEY) {
    const groq = new GroqLlm(e.GROQ_API_KEY, e.GROQ_MODEL);
    console.warn("groq text", await collect(groq, plain));
    console.warn("groq tool", await collect(groq, toolReq));
  }
}
main().catch((err: unknown) => {
  console.error("SMOKE FAILED:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
});
