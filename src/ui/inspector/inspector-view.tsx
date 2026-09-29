"use client";

import { ChevronRight, ScanSearch } from "lucide-react";
import type { RetrievalEventDTO } from "@/core/domain/types";
import { RetrievalPanel } from "../chat/retrieval-panel";
import { Badge, EmptyState } from "../primitives";

/** Retrieval-debug view: proves, per answer, which workspace and which chunks were used. */
export function InspectorView({ workspace, events }: { workspace: { id: string; name: string; color: string }; events: RetrievalEventDTO[] }) {
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Retrieval inspector</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-2">
          Every question is logged with the chunks the search returned, their scores from each retriever, and the workspace each chunk belongs to. This is the evidence that <b className="text-ink">{workspace.name}</b> only ever draws on its own documents.
        </p>
      </header>
      {events.length === 0 ? (
        <div className="rounded-xl border border-line bg-panel">
          <EmptyState icon={<ScanSearch />} title="No retrievals yet">Ask a question in Chat, then come back to see exactly what was retrieved and why.</EmptyState>
        </div>
      ) : (
        <ul className="space-y-3">
          {events.map((e) => (
            <li key={e.id} className="overflow-hidden rounded-xl border border-line bg-panel">
              <details className="group">
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 p-4 hover:bg-panel-2 [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-4 shrink-0 text-ink-3 transition-transform group-open:rotate-90" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">{e.query}</span>
                  <Badge tone={e.hit ? "good" : "neutral"}>{e.hit ? "evidence found" : "no evidence"}</Badge>
                  <Badge>{e.results.length} chunks</Badge>
                  <time dateTime={e.createdAt} className="text-[12px] tabular text-ink-3">{new Date(e.createdAt).toLocaleString()}</time>
                </summary>
                <div className="border-t border-line p-4">
                  <RetrievalPanel event={e} workspaceName={workspace.name} workspaceColor={workspace.color} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
