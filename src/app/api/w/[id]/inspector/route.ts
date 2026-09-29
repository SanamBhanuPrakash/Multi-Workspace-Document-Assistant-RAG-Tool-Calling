import { notFound } from "@/core/domain/errors";
import { isUuid } from "@/core/security/tenant";
import { dashboardQueries } from "@/infra/db/queries";
import { json, workspaceRoute } from "../../../_lib/http";

export const dynamic = "force-dynamic";

/**
 * Retrieval-debug view: which workspace and which chunks an answer drew from, with rank/score per retriever.
 * Every row carries its owning workspace id, so isolation can be verified by eye — and by the `isolation` block below.
 */
export const GET = workspaceRoute({}, async ({ req, scope, requestId }) => {
  const messageId = new URL(req.url).searchParams.get("messageId");
  if (messageId) {
    if (!isUuid(messageId)) throw notFound("Retrieval record");
    const event = await dashboardQueries.retrievalForMessage(scope, messageId);
    if (!event) throw notFound("Retrieval record");
    return json({ event, isolation: proof(scope.workspaceId, [event]) }, requestId);
  }
  const events = await dashboardQueries.recentRetrievals(scope, 20);
  return json({ events, isolation: proof(scope.workspaceId, events) }, requestId);
});

/** A verifiable statement about the returned data: every candidate chunk belongs to the active workspace or was explicitly shared in. */
function proof(activeWorkspaceId: string, events: { results: { workspaceId: string; sharedFrom: string | null }[] }[]) {
  let total = 0;
  let own = 0;
  let sharedIn = 0;
  let violations = 0;
  for (const e of events)
    for (const r of e.results) {
      total++;
      if (r.workspaceId === activeWorkspaceId) own++;
      else if (r.sharedFrom) sharedIn++;
      else violations++;
    }
  return { activeWorkspaceId, chunksInspected: total, ownWorkspace: own, sharedIn, violations, verified: violations === 0 };
}
