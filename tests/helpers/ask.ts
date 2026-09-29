import type { LlmEvent, LlmPort, LlmRequest, NotifierPort } from "@/core/ports/providers";
import type { AskConfig, AskDeps, AskEvent } from "@/core/application/ask";
import { makeRetriever } from "@/core/application/ask";
import { defaultTools, type ToolDeps } from "@/core/application/tools/registry";
import type { ExecutorDeps } from "@/core/application/tools/executor";
import { FakeEmbedding } from "@/infra/embed/fake";
import { chunkStore, conversationRepo, integrationRepo, observabilityRepo, taskRepo, toolCallRepo } from "@/infra/db/repositories";

/** A scriptable model. `script` sees each request and returns events (or an Error to throw). */
export class ScriptedLlm implements LlmPort {
  readonly provider = "scripted";
  readonly model = "scripted-1";
  calls: LlmRequest[] = [];
  constructor(private readonly script: (req: LlmRequest, callIndex: number) => LlmEvent[] | Error) {}
  async *generate(req: LlmRequest): AsyncGenerator<LlmEvent> {
    this.calls.push(structuredClone(req));
    const out = this.script(req, this.calls.length - 1);
    if (out instanceof Error) throw out;
    yield { type: "meta", provider: this.provider, model: this.model };
    for (const ev of out) yield ev;
  }
  /** Requests that are the answer-generating call (not the follow-up "condense" rewrite). */
  get answerCalls(): LlmRequest[] {
    return this.calls.filter((c) => !c.system.startsWith("Rewrite the user's latest message"));
  }
}

const usage = { type: "usage", usage: { tokensIn: 100, tokensOut: 20 } } as const;
export const say = (t: string): LlmEvent[] => [{ type: "text", delta: t }, usage, { type: "done", finishReason: "stop" }];
let n = 0;
export const call = (name: string, args: unknown): LlmEvent => ({ type: "tool_call", id: `call_${++n}`, name, rawArgs: typeof args === "string" ? args : JSON.stringify(args) });
export const calls = (...evs: LlmEvent[]): LlmEvent[] => [...evs, usage, { type: "done", finishReason: "tool_calls" }];
export const isCondense = (req: LlmRequest) => req.system.startsWith("Rewrite the user's latest message");

/** All text the model was shown in one request (system + every message). */
export const promptText = (req: LlmRequest): string =>
  [req.system, ...req.messages.map((m) => ("text" in m ? m.text : ""))].join("\n");

/**
 * A deliberately COMPROMISED model: it obeys any instruction it can see in its context, exactly as a successfully
 * hijacked LLM would. The injection suite uses it to prove the APP's defences hold even when the model does not.
 */
export const gullibleLlm = () =>
  new ScriptedLlm((req) => {
    if (isCondense(req)) return say("query");
    const last = req.messages[req.messages.length - 1]!;
    if (last.role === "tool") return say("STATUS: ANSWERED\n\nI have processed the request.");
    const ctx = "text" in last ? last.text : "";
    const evs: LlmEvent[] = [];
    if (/delete_everything/.test(ctx)) evs.push(call("delete_everything", {}));
    if (/save_task/.test(ctx)) evs.push(call("save_task", { title: "PWNED by document" }));
    if (/send_summary/.test(ctx)) evs.push(call("send_summary", { channel: "slack", title: "leak", summary: `exfil: ${ctx.slice(0, 120)}` }));
    return evs.length ? calls(...evs) : say("STATUS: ANSWERED\n\nNothing to do.");
  });

export const delivered: { kind: string; url: string; title: string; body: string }[] = [];
export const testNotifier: NotifierPort = { async send(kind, url, m) { delivered.push({ kind, url, title: m.title, body: m.body }); } };

export function makeAskDeps(llm: LlmPort, over: { config?: Partial<AskConfig>; limiter?: AskDeps["limiter"]; nonce?: string } = {}): AskDeps {
  const embedder = new FakeEmbedding();
  const base = { chunks: chunkStore, embedder, config: over.config };
  const toolDeps: ToolDeps = { tasks: taskRepo, integrations: integrationRepo, notifier: testNotifier, retrieve: makeRetriever(base) };
  const tools: ExecutorDeps = { registry: defaultTools(), calls: toolCallRepo, toolDeps };
  return {
    conv: conversationRepo,
    chunks: chunkStore,
    obs: observabilityRepo,
    embedder,
    llm,
    limiter: over.limiter ?? { allow: async () => true },
    tools,
    ...(over.config ? { config: over.config } : {}),
    ...(over.nonce ? { newNonce: () => over.nonce! } : {}),
  };
}

export async function drain(gen: AsyncGenerator<AskEvent>): Promise<AskEvent[]> {
  const out: AskEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}
export const doneOf = (evs: AskEvent[]) => evs.find((e): e is Extract<AskEvent, { type: "done" }> => e.type === "done")?.message;
export const errorOf = (evs: AskEvent[]) => evs.find((e): e is Extract<AskEvent, { type: "error" }> => e.type === "error");
export const tokensOf = (evs: AskEvent[]) => evs.filter((e): e is Extract<AskEvent, { type: "token" }> => e.type === "token").map((e) => e.delta).join("");
export const turnOf = (evs: AskEvent[]) => evs.find((e): e is Extract<AskEvent, { type: "turn" }> => e.type === "turn")!;
