"use client";

import { Activity, Gauge, Table2 } from "lucide-react";
import * as React from "react";
import type { ObservabilitySummary } from "@/core/domain/types";
import { api } from "../api";
import { cn } from "../cn";
import { Badge, Button, Card, Spinner } from "../primitives";

const n = (v: number) => v.toLocaleString();
const ms = (v: number | null) => (v === null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

export function InsightsView({ workspaceId, initial }: { workspaceId: string; initial: ObservabilitySummary }) {
  const [hours, setHours] = React.useState(initial.windowHours);
  const [data, setData] = React.useState(initial);
  const loading = hours !== data.windowHours; // derived: the fetch below replaces `data` and clears it

  React.useEffect(() => {
    if (hours === data.windowHours) return;
    let live = true;
    api<{ summary: ObservabilitySummary }>(`/api/w/${workspaceId}/observability?hours=${hours}`)
      .then((r) => live && setData(r.summary))
      .catch(() => live && setHours(data.windowHours)); // fall back to the window we still have
    return () => {
      live = false;
    };
  }, [hours, workspaceId, data.windowHours]);

  const errorRate = data.requests ? data.errors / data.requests : null;
  const toolTotals = data.tools.reduce<Record<string, Record<string, number>>>((acc, t) => {
    (acc[t.name] ??= {})[t.status] = t.count;
    return acc;
  }, {});

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Insights</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-2">Per-request latency, token usage, retrieval hit rate, and tool outcomes for this workspace only.</p>
        </div>
        <div role="group" aria-label="Time window" className="flex items-center gap-1 rounded-lg border border-line bg-panel p-1">
          {[24, 72, 168].map((h) => (
            <button key={h} onClick={() => setHours(h)} aria-pressed={hours === h} className={cn("h-8 rounded-md px-3 text-[13px] font-medium", hours === h ? "bg-brand-soft text-brand" : "text-ink-2 hover:text-ink")}>
              {h === 24 ? "24 h" : h === 72 ? "3 days" : "7 days"}
            </button>
          ))}
          {loading ? <Spinner className="mx-1" /> : null}
        </div>
      </header>

      <section aria-label="Key metrics" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Questions answered" value={n(data.requests)} sub={`${data.abstained} declined (not in documents)`} />
        <Kpi label="Retrieval hit rate" value={pct(data.retrievalHitRate)} sub="questions with relevant evidence" />
        <Kpi label="Latency p50 / p95" value={`${ms(data.latencyMs.p50)} / ${ms(data.latencyMs.p95)}`} sub={`first token p50 ${ms(data.firstTokenMs.p50)}`} />
        <Kpi label="Error rate" value={pct(errorRate)} sub={`${data.errors} failed · ${n(data.tokensIn)} in / ${n(data.tokensOut)} out tokens`} tone={errorRate && errorRate > 0.1 ? "bad" : undefined} />
      </section>

      <HourlyChart hourly={data.hourly} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">Models that served requests</h2>
          {data.byProvider.length === 0 ? (
            <p className="p-4 text-sm text-ink-2">No requests in this window.</p>
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead className="text-[11px] uppercase tracking-wide text-ink-3">
                <tr><th className="px-4 py-2 font-medium">Provider / model</th><th className="px-4 py-2 text-right font-medium">Requests</th><th className="px-4 py-2 text-right font-medium">Tokens in</th><th className="px-4 py-2 text-right font-medium">Tokens out</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.byProvider.map((p) => (
                  <tr key={`${p.provider}/${p.model}`}>
                    <td className="px-4 py-2"><span className="font-medium text-ink">{p.provider}</span> <span className="font-mono text-[12px] text-ink-3">{p.model}</span></td>
                    <td className="px-4 py-2 text-right tabular">{n(p.requests)}</td>
                    <td className="px-4 py-2 text-right tabular">{n(p.tokensIn)}</td>
                    <td className="px-4 py-2 text-right tabular">{n(p.tokensOut)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card className="overflow-hidden">
          <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">Tool call outcomes</h2>
          {Object.keys(toolTotals).length === 0 ? (
            <p className="p-4 text-sm text-ink-2">No tool calls in this window.</p>
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead className="text-[11px] uppercase tracking-wide text-ink-3">
                <tr><th className="px-4 py-2 font-medium">Tool</th><th className="px-4 py-2 text-right font-medium">Succeeded</th><th className="px-4 py-2 text-right font-medium">Failed</th><th className="px-4 py-2 text-right font-medium">Blocked</th><th className="px-4 py-2 text-right font-medium">Held / declined</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {Object.entries(toolTotals).map(([name, s]) => (
                  <tr key={name}>
                    <td className="px-4 py-2 font-mono text-ink">{name}</td>
                    <td className="px-4 py-2 text-right tabular">{s.succeeded ?? 0}</td>
                    <td className="px-4 py-2 text-right tabular">{s.failed ?? 0}</td>
                    <td className="px-4 py-2 text-right tabular">{s.rejected ?? 0}</td>
                    <td className="px-4 py-2 text-right tabular">{(s.awaiting_confirmation ?? 0) + (s.declined ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card className="flex flex-wrap items-center gap-4 p-4 text-sm">
        <Gauge className="size-5 text-ink-3" aria-hidden />
        <span className="text-ink-2">Documents:</span>
        <Badge tone="good">{data.ingestion.ready} ready</Badge>
        <Badge tone={data.ingestion.processing ? "brand" : "neutral"}>{data.ingestion.processing} indexing</Badge>
        <Badge tone={data.ingestion.failed ? "bad" : "neutral"}>{data.ingestion.failed} failed</Badge>
      </Card>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "bad" }) {
  return (
    <Card className="p-4">
      <p className="text-[12px] font-medium text-ink-2">{label}</p>
      <p className={cn("mt-1.5 text-2xl font-semibold tabular tracking-tight text-ink", tone === "bad" && "text-bad")}>{value}</p>
      <p className="mt-1 text-[12px] text-ink-3">{sub}</p>
    </Card>
  );
}

/**
 * Single-series bar chart: requests per hour (magnitude over time). One series ⇒ no legend box, no categorical palette; the
 * title names it. Thin bars with a rounded data-end anchored to the baseline; hover shows the exact value; a table view is
 * one click away so nothing depends on seeing the chart.
 */
function HourlyChart({ hourly }: { hourly: ObservabilitySummary["hourly"] }) {
  const [table, setTable] = React.useState(false);
  const [hover, setHover] = React.useState<number | null>(null);
  const W = 720;
  const H = 180;
  const pad = { l: 34, r: 8, t: 10, b: 24 };
  const max = Math.max(1, ...hourly.map((h) => h.requests));
  const bw = Math.max(3, Math.min(18, (W - pad.l - pad.r) / Math.max(hourly.length, 1) - 4));
  const step = (W - pad.l - pad.r) / Math.max(hourly.length, 1);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink"><Activity className="size-4 text-ink-3" aria-hidden /> Requests per hour</h2>
        <Button variant="ghost" size="sm" onClick={() => setTable((t) => !t)} aria-pressed={table}><Table2 /> {table ? "Show chart" : "View as table"}</Button>
      </div>
      {hourly.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-2">No requests yet in this window. Ask a question in Chat and it will appear here.</p>
      ) : table ? (
        <div className="mt-3 max-h-64 overflow-auto rounded-md border border-line">
          <table className="w-full text-left text-[13px]">
            <caption className="sr-only">Requests, errors and p95 latency per hour</caption>
            <thead className="sticky top-0 bg-panel-2 text-[11px] uppercase tracking-wide text-ink-3"><tr><th className="px-3 py-2 font-medium">Hour (UTC)</th><th className="px-3 py-2 text-right font-medium">Requests</th><th className="px-3 py-2 text-right font-medium">Errors</th><th className="px-3 py-2 text-right font-medium">p95</th></tr></thead>
            <tbody className="divide-y divide-line">{hourly.map((h) => <tr key={h.hour}><td className="px-3 py-1.5 font-mono text-[12px]">{h.hour.replace("T", " ").replace(":00:00Z", ":00")}</td><td className="px-3 py-1.5 text-right tabular">{h.requests}</td><td className="px-3 py-1.5 text-right tabular">{h.errors}</td><td className="px-3 py-1.5 text-right tabular">{ms(h.p95Ms)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : (
        <div className="relative mt-3">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Bar chart of requests per hour. Peak ${max} in one hour. Use “View as table” for exact values.`}>
            {[0, 0.5, 1].map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={W - pad.r} y1={y(max * t)} y2={y(max * t)} stroke="var(--line)" strokeWidth="1" />
                <text x={pad.l - 6} y={y(max * t) + 4} textAnchor="end" className="fill-ink-3 text-[10px]">{Math.round(max * t)}</text>
              </g>
            ))}
            {hourly.map((h, i) => {
              const x = pad.l + i * step + (step - bw) / 2;
              const top = y(h.requests);
              const base = y(0);
              const hh = Math.max(2, base - top);
              return (
                <g key={h.hour} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  <rect x={pad.l + i * step} y={pad.t} width={step} height={H - pad.t - pad.b} fill="transparent" /> {/* generous hit target */}
                  <path d={`M${x},${base} V${base - hh + 4} a4,4 0 0 1 4,-4 h${bw - 8} a4,4 0 0 1 4,4 V${base} Z`} fill="var(--brand)" opacity={hover === null || hover === i ? 1 : 0.45} />
                </g>
              );
            })}
            {hourly.length > 1 ? [0, hourly.length - 1].map((i) => <text key={i} x={pad.l + i * step + step / 2} y={H - 6} textAnchor={i === 0 ? "start" : "end"} className="fill-ink-3 text-[10px]">{hourly[i]!.hour.slice(5, 13).replace("T", " ")}h</text>) : null}
          </svg>
          {hover !== null ? (
            <div className="pointer-events-none absolute right-2 top-0 rounded-md border border-line bg-panel-3 px-2.5 py-1.5 text-xs shadow-2" role="status">
              <span className="font-mono text-ink-3">{hourly[hover]!.hour.slice(5, 13).replace("T", " ")}:00 UTC</span>
              <span className="ml-2 font-medium tabular text-ink">{hourly[hover]!.requests} requests</span>
              {hourly[hover]!.errors ? <span className="ml-2 text-bad">{hourly[hover]!.errors} errors</span> : null}
              <span className="ml-2 text-ink-2">p95 {ms(hourly[hover]!.p95Ms)}</span>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
