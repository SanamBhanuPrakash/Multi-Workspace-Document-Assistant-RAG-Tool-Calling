"use client";

import { Ban, Check, CheckCircle2, ChevronRight, Loader2, ShieldAlert, Wrench, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import type { ToolCallDTO } from "@/core/domain/types";
import { api, ApiError } from "../api";
import { cn } from "../cn";
import { Badge, Button, EmptyState } from "../primitives";

const STATUS: Record<string, { tone: "good" | "warn" | "bad" | "neutral" | "brand"; label: string; icon: React.ReactNode }> = {
  succeeded: { tone: "good", label: "Succeeded", icon: <CheckCircle2 className="size-3" /> },
  running: { tone: "brand", label: "Running", icon: <Loader2 className="size-3 animate-spin" /> },
  awaiting_confirmation: { tone: "warn", label: "Awaiting approval", icon: <ShieldAlert className="size-3" /> },
  rejected: { tone: "bad", label: "Rejected", icon: <Ban className="size-3" /> },
  failed: { tone: "bad", label: "Failed", icon: <X className="size-3" /> },
  declined: { tone: "neutral", label: "Declined", icon: <X className="size-3" /> },
};
const pretty = (v: unknown) => (v === null || v === undefined ? "—" : JSON.stringify(v, null, 2));

export function ActivityView({ workspaceId, initial, canWrite }: { workspaceId: string; initial: ToolCallDTO[]; canWrite: boolean }) {
  const [calls, setCalls] = React.useState(initial);
  const [busy, setBusy] = React.useState<string | null>(null);

  async function decide(c: ToolCallDTO, decision: "confirm" | "decline") {
    setBusy(c.id);
    try {
      const r = await api<{ status: string }>(`/api/w/${workspaceId}/tools/${c.id}`, { method: "POST", json: { decision } });
      setCalls((all) => all.map((x) => (x.id === c.id ? { ...x, status: r.status as ToolCallDTO["status"] } : x)));
      toast[r.status === "succeeded" ? "success" : "message"](r.status === "succeeded" ? "Approved and completed" : r.status === "declined" ? "Declined" : "Could not complete");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not record your decision.");
    } finally {
      setBusy(null);
    }
  }

  const held = calls.filter((c) => c.status === "awaiting_confirmation").length;
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-8">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Tool log</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-2">Every action the assistant proposed in this workspace — including ones that were <b className="text-ink">blocked</b> (unknown tool, invalid arguments) or <b className="text-ink">held</b> for your approval. The model proposes; the app validates and decides.</p>
      </header>

      {held ? (
        <div role="status" className="flex items-center gap-3 rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-ink">
          <ShieldAlert className="size-5 shrink-0 text-warn" aria-hidden />
          {held} action{held === 1 ? " is" : "s are"} waiting for your approval. They were held because a retrieved document contained instructions aimed at the assistant.
        </div>
      ) : null}

      {calls.length === 0 ? (
        <div className="rounded-xl border border-line bg-panel">
          <EmptyState icon={<Wrench />} title="No tool calls yet">
            Ask the assistant to “save a task: …” or “send a summary to Slack” and the call will appear here with its arguments, result and latency.
          </EmptyState>
        </div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel" aria-label="Tool calls">
          {calls.map((c) => {
            const s = STATUS[c.status] ?? { tone: "neutral" as const, label: c.status, icon: null };
            return (
              <li key={c.id}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-2 p-4 hover:bg-panel-2 [&::-webkit-details-marker]:hidden">
                    <ChevronRight className="size-4 shrink-0 text-ink-3 transition-transform group-open:rotate-90" aria-hidden />
                    <span className="font-mono text-sm font-medium text-ink">{c.toolName}</span>
                    <Badge tone={s.tone}>{s.icon} {s.label}</Badge>
                    {c.tainted ? <Badge tone="warn">tainted context</Badge> : null}
                    {c.errorCode ? <span className="text-[13px] text-ink-2">{c.errorCode.replaceAll("_", " ")}</span> : null}
                    <span className="ml-auto flex items-center gap-4 text-[13px] tabular text-ink-3">
                      {c.latencyMs !== null ? <span>{c.latencyMs} ms</span> : null}
                      <time dateTime={c.createdAt}>{new Date(c.createdAt).toLocaleString()}</time>
                    </span>
                  </summary>
                  <div className="space-y-4 border-t border-line bg-panel-2 p-4 text-[13px]">
                    {c.status === "awaiting_confirmation" && canWrite ? (
                      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warn/40 bg-warn-soft p-3">
                        <p className="flex-1 text-ink">Not executed. Approve only if <i>you</i> want this done.</p>
                        <Button size="sm" variant="primary" loading={busy === c.id} disabled={busy !== null} onClick={() => void decide(c, "confirm")}><Check /> Approve</Button>
                        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void decide(c, "decline")}>Decline</Button>
                      </div>
                    ) : null}
                    <div className="grid gap-4 lg:grid-cols-2">
                      <Detail title="What the model asked for (raw, untrusted)" body={c.rawArgs} />
                      <Detail title="Validated arguments" body={pretty(c.validatedArgs)} muted={c.validatedArgs === null} />
                    </div>
                    <Detail title={c.status === "succeeded" ? "Result" : "Outcome"} body={c.errorMessage ? `${c.errorCode ?? "error"}: ${c.errorMessage}` : pretty(c.result)} />
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Detail({ title, body, muted }: { title: string; body: string; muted?: boolean }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">{title}</p>
      <pre className={cn("max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-panel p-3 font-mono text-[12px] leading-relaxed", muted ? "text-ink-3" : "text-ink")}>{body}</pre>
    </div>
  );
}
