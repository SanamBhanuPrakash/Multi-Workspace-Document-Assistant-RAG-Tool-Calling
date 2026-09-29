"use client";

import { AlertTriangle, CheckCircle2, ShieldCheck, ShieldX } from "lucide-react";
import type { RetrievalEventDTO } from "@/core/domain/types";
import { cn } from "../cn";
import { Badge } from "../primitives";
import { sectionLabel } from "../section-label";

const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
const short = (id: string) => `${id.slice(0, 8)}…`;

/** Evidence that isolation held for this answer: every candidate chunk is the active workspace's own (or explicitly shared in). */
export function IsolationProof({ event, workspaceName }: { event: RetrievalEventDTO; workspaceName: string }) {
  const own = event.results.filter((r) => r.workspaceId === event.workspaceId).length;
  const shared = event.results.filter((r) => r.workspaceId !== event.workspaceId && r.sharedFrom).length;
  const violations = event.results.length - own - shared;
  const ok = violations === 0;
  return (
    <div role="status" className={cn("flex items-start gap-3 rounded-lg border p-3 text-sm", ok ? "border-good/30 bg-good-soft text-ink" : "border-bad/40 bg-bad-soft text-ink")}>
      {ok ? <ShieldCheck className="mt-0.5 size-5 shrink-0 text-good" aria-hidden /> : <ShieldX className="mt-0.5 size-5 shrink-0 text-bad" aria-hidden />}
      <div>
        <p className="font-medium">{ok ? "Isolation verified" : "ISOLATION VIOLATION"}</p>
        <p className="mt-0.5 text-[13px] text-ink-2">
          {event.results.length} candidate chunk{event.results.length === 1 ? "" : "s"} inspected · <b className="text-ink">{own}</b> from <b className="text-ink">{workspaceName}</b>
          {shared ? <> · {shared} explicitly shared in</> : null} · <b className={violations ? "text-bad" : "text-ink"}>{violations}</b> from any other workspace.
        </p>
        <p className="mt-1 font-mono text-[11px] text-ink-3">workspace {event.workspaceId}</p>
      </div>
    </div>
  );
}

export function RetrievalPanel({ event, workspaceName, workspaceColor }: { event: RetrievalEventDTO; workspaceName: string; workspaceColor: string }) {
  const used = event.results.filter((r) => r.usedInContext).length;
  return (
    <div className="space-y-4">
      <IsolationProof event={event} workspaceName={workspaceName} />

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {[
          ["Outcome", event.hit ? "Evidence found" : "No evidence"],
          ["Top similarity", pct(event.topSimilarity)],
          ["Used in prompt", `${used} / ${event.results.length}`],
          ["Retrieval time", `${event.latencyMs} ms`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-md border border-line bg-panel-2 p-2.5">
            <dt className="text-[11px] uppercase tracking-wide text-ink-3">{k}</dt>
            <dd className="mt-0.5 font-medium tabular text-ink">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="space-y-1.5 text-sm">
        <p className="text-ink-2">
          <span className="text-ink-3">Question:</span> {event.query}
        </p>
        {event.standaloneQuery !== event.query ? (
          <p className="text-ink-2">
            <span className="text-ink-3">Searched as:</span> {event.standaloneQuery}
          </p>
        ) : null}
        <p className="text-[12px] text-ink-3">
          Hybrid search: vector top-{event.params.candidatePool} ∪ keyword top-{event.params.candidatePool}, fused with reciprocal-rank fusion (k={event.params.rrfK}); relevance gate {pct(event.params.minSimilarity)} cosine.
        </p>
      </div>

      {event.results.length === 0 ? (
        <p className="rounded-md border border-line bg-panel-2 p-4 text-sm text-ink-2">The workspace returned no candidate chunks for this query.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <caption className="sr-only">Retrieved chunks with scores</caption>
            <thead className="bg-panel-2 text-[11px] uppercase tracking-wide text-ink-3">
              <tr>
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Vector</th>
                <th className="px-3 py-2 font-medium">Keyword</th>
                <th className="px-3 py-2 font-medium">RRF</th>
                <th className="px-3 py-2 font-medium">Workspace</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {event.results.map((r, i) => (
                <tr key={r.chunkId} className={cn(r.usedInContext ? "bg-brand-soft/40" : "")}>
                  <td className="px-3 py-2 tabular text-ink-3">{i + 1}</td>
                  <td className="max-w-[16rem] px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      {r.usedInContext ? <CheckCircle2 className="size-3.5 shrink-0 text-good" aria-label="Used in the prompt" /> : null}
                      <span className="truncate font-medium text-ink">{r.documentTitle}</span>
                      {r.flagged ? (
                        <Badge tone="warn" title="The ingestion scanner flagged suspicious instructions in this chunk">
                          <AlertTriangle className="size-3" aria-hidden /> flagged
                        </Badge>
                      ) : null}
                    </div>
                    <div className="truncate text-[12px] text-ink-2">{sectionLabel(r.documentTitle, r.headingPath ?? "")}</div>
                    <div className="font-mono text-[11px] text-ink-3">chunk {short(r.chunkId)} · §{r.ordinal}</div>
                  </td>
                  <td className="px-3 py-2 tabular">
                    <div className="flex items-center gap-2">
                      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-panel-3" aria-hidden>
                        <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.max(2, Math.round((r.vectorSimilarity ?? 0) * 100))}%` }} />
                      </span>
                      {pct(r.vectorSimilarity)}
                      {r.vectorRank ? <span className="text-ink-3">#{r.vectorRank}</span> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 tabular">{r.keywordRank ? <>#{r.keywordRank}</> : <span className="text-ink-3">—</span>}</td>
                  <td className="px-3 py-2 tabular">{r.rrfScore.toFixed(4)}</td>
                  <td className="px-3 py-2">
                    {r.workspaceId === event.workspaceId ? (
                      <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-2">
                        <span aria-hidden className="size-2 rounded-full" style={{ background: workspaceColor }} />
                        {short(r.workspaceId)}
                      </span>
                    ) : r.sharedFrom ? (
                      <Badge tone="brand">shared in</Badge>
                    ) : (
                      <Badge tone="bad">FOREIGN</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
