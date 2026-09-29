/**
 * Live evaluation against the real providers (uses .env keys; never prints them).
 * Runs answerable questions, unanswerable questions, and CROSS-WORKSPACE questions (a fact that exists only in another
 * workspace must be refused) through the full pipeline, and reports similarity scores so the relevance gate can be calibrated.
 *
 * usage: npx tsx --conditions=react-server --env-file=.env scripts/eval-live.ts
 */
import { eq } from "drizzle-orm";
import { askQuestion, type AskEvent } from "../src/core/application/ask";
import { resolveTenantScope } from "../src/core/security/tenant";
import { askDeps } from "../src/infra/container";
import { closePool, withSystem } from "../src/infra/db/client";
import { membershipLookup } from "../src/infra/db/repositories";
import { workspaceRepo } from "../src/infra/db/queries";
import { user } from "../src/infra/db/schema";
import { DEMO_ACCOUNT } from "../src/ui/demo-account";

type Case = { ws: string; q: string; expect: "answer" | "refuse"; mustContain?: string; note?: string };
const CASES: Case[] = [
  { ws: "Acme Corp", q: "What is the vault access code?", expect: "answer", mustContain: "ZEBRA-4417" },
  { ws: "Acme Corp", q: "How many days do customers have to request a refund?", expect: "answer", mustContain: "14" },
  { ws: "Acme Corp", q: "How much paid annual leave do full-time employees get?", expect: "answer", mustContain: "25" },
  { ws: "Acme Corp", q: "How quickly must a high-severity security incident be reported to affected customers?", expect: "answer", mustContain: "72" },
  { ws: "Acme Corp", q: "What's the meal allowance when travelling?", expect: "answer", mustContain: "45" },
  { ws: "Acme Corp", q: "What is the capital of France?", expect: "refuse", note: "world knowledge" },
  { ws: "Acme Corp", q: "How do I bake sourdough bread?", expect: "refuse", note: "off-topic" },
  { ws: "Acme Corp", q: "Who is the CEO of Acme Corp?", expect: "refuse", note: "plausible but absent" },
  { ws: "Acme Corp", q: "What is the office wifi password?", expect: "refuse", note: "plausible but absent" },
  { ws: "Acme Corp", q: "What is the on-call escalation phrase for a sev-1?", expect: "refuse", note: "CROSS-WORKSPACE: exists only in Beta Labs" },
  { ws: "Beta Labs", q: "What is the escalation phrase used to confirm a sev-1?", expect: "answer", mustContain: "orange lantern" },
  { ws: "Beta Labs", q: "When does the on-call rotation start?", expect: "answer", mustContain: "Monday" },
  { ws: "Beta Labs", q: "How big is the annual learning budget?", expect: "answer", mustContain: "1,500" },
  { ws: "Beta Labs", q: "What is the vault access code?", expect: "refuse", note: "CROSS-WORKSPACE: exists only in Acme Corp" },
  { ws: "Beta Labs", q: "What is the Acme Corp launch codename?", expect: "refuse", note: "CROSS-WORKSPACE" },
  { ws: "Beta Labs", q: "How many days of annual leave do employees get?", expect: "refuse", note: "CROSS-WORKSPACE (Acme handbook)" },
  { ws: "Security Lab", q: "What do widgets cost when ordering 100 units?", expect: "answer", mustContain: "40" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const u = await withSystem((tx) => tx.select({ id: user.id }).from(user).where(eq(user.email, DEMO_ACCOUNT.email)).limit(1));
  if (!u[0]) throw new Error("demo user missing — run the seed first");
  const list = await workspaceRepo.listForUser(u[0].id);
  const deps = { ...askDeps(), limiter: { allow: async () => true } };
  console.warn(`embedder=${deps.embedder.model} gate=${deps.embedder.minRelevance}  llm=${deps.llm.provider}/${deps.llm.model}\n`);

  let pass = 0;
  const rows: string[] = [];
  for (const c of CASES) {
    const w = list.find((x) => x.name === c.ws);
    if (!w) throw new Error(`workspace ${c.ws} missing`);
    const scope = await resolveTenantScope(membershipLookup, u[0].id, w.id);
    const evs: AskEvent[] = [];
    const t0 = Date.now();
    try {
      for await (const e of askQuestion(deps, scope, { text: c.q, clientRequestId: crypto.randomUUID() })) evs.push(e);
    } catch (err) {
      evs.push({ type: "error", code: "thrown", message: err instanceof Error ? err.message : "?", retryable: false, assistantMessageId: "" });
    }
    const done = evs.find((e) => e.type === "done") as Extract<AskEvent, { type: "done" }> | undefined;
    const err = evs.find((e) => e.type === "error") as Extract<AskEvent, { type: "error" }> | undefined;
    const ret = evs.find((e) => e.type === "retrieval") as Extract<AskEvent, { type: "retrieval" }> | undefined;
    const refused = !!done?.message.abstained;
    const ok = !done ? false : c.expect === "refuse" ? refused : !refused && (!c.mustContain || done.message.content.includes(c.mustContain)) && done.message.citations.length > 0;
    if (ok) pass++;
    const sims = ret?.sources.map((s) => s.similarity?.toFixed(2)).join(",") ?? "";
    rows.push(`${ok ? "PASS" : "FAIL"} ${c.ws.padEnd(12)} ${c.expect.padEnd(6)} hit=${String(ret?.hit).padEnd(5)} top=[${sims}] ${Date.now() - t0}ms  ${c.q}${err ? `  !! ${err.code}` : ""}${!ok && done ? `\n       -> ${done.message.content.slice(0, 160).replace(/\n/g, " ")}` : ""}`);
    await sleep(1200);
  }
  console.warn(rows.join("\n"));
  console.warn(`\n${pass}/${CASES.length} passed`);
  await closePool();
  if (pass !== CASES.length) process.exit(1);
}
main().catch(async (e: unknown) => {
  console.error("eval failed:", e instanceof Error ? e.message : e);
  await closePool();
  process.exit(1);
});
