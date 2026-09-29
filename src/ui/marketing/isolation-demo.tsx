"use client";

import { Ban, FileText, Lock, ShieldCheck } from "lucide-react";
import * as React from "react";
import { cn } from "../cn";

/**
 * Illustrative hero widget: the same question asked in two workspaces that share one vector store. It mirrors the real
 * product behaviour (verified by the canary test-suite) but is static content — clearly labelled as such.
 */
const WS = {
  a: { name: "Acme Corp", color: "#5b8def", docs: ["acme-handbook.md", "acme-security-policy.md"] },
  b: { name: "Beta Labs", color: "#22c1a4", docs: ["beta-onboarding.md", "beta-incident-runbook.md"] },
} as const;

export function IsolationDemo() {
  const [ws, setWs] = React.useState<"a" | "b">("a");
  const cur = WS[ws];
  return (
    <div className="rounded-2xl border border-line bg-panel shadow-2" role="region" aria-label="Interactive isolation illustration">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div role="tablist" aria-label="Choose a workspace" className="flex gap-1 rounded-lg bg-panel-2 p-1">
          {(["a", "b"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={ws === k} onClick={() => setWs(k)} className={cn("flex h-8 items-center gap-2 rounded-md px-3 text-[13px] font-medium transition-colors", ws === k ? "bg-panel text-ink shadow-1" : "text-ink-2 hover:text-ink")}>
              <span aria-hidden className="size-2 rounded-full" style={{ background: WS[k].color }} />
              {WS[k].name}
            </button>
          ))}
        </div>
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-good"><Lock className="size-3" aria-hidden /> sealed</span>
      </div>

      <div className="space-y-4 p-4" aria-live="polite">
        <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-brand-soft px-4 py-2.5 text-sm text-ink">What is the vault access code?</div>

        {ws === "a" ? (
          <div key="a" className="rise-in space-y-3">
            <p className="text-[15px] text-ink">The vault access code for the Lisbon office is <b>ZEBRA-4417</b> <span className="mx-0.5 inline-grid h-[18px] min-w-[18px] place-items-center rounded bg-brand-soft px-1 font-mono text-[11px] font-medium text-brand">1</span>.</p>
            <div className="inline-flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-xs text-ink-2"><FileText className="size-3" aria-hidden /> <b className="text-ink">Acme Corp Employee Handbook</b> · Office security</div>
          </div>
        ) : (
          <div key="b" className="rise-in space-y-3">
            <div className="rounded-lg border border-line bg-panel-2 px-4 py-3 text-[15px] text-ink-2">
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3"><Ban className="size-3.5" aria-hidden /> Not in this workspace&apos;s documents</p>
              I don&apos;t know — this workspace&apos;s documents don&apos;t contain an answer to that.
            </div>
          </div>
        )}

        <div className={cn("flex items-start gap-2.5 rounded-lg border p-3 text-[13px]", "border-good/30 bg-good-soft")}>
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-good" aria-hidden />
          <p className="text-ink-2"><b className="text-ink">Isolation verified.</b> {ws === "a" ? "6 candidate chunks inspected — 6 from Acme Corp, 0 from any other workspace." : "0 chunks returned — Acme Corp's documents exist in the same table, but this query can't reach them."}</p>
        </div>
        <p className="text-[11px] text-ink-3">Illustration of real behaviour · both workspaces share one <code className="font-mono">chunks</code> table · documents here: {cur.docs.join(", ")}</p>
      </div>
    </div>
  );
}
