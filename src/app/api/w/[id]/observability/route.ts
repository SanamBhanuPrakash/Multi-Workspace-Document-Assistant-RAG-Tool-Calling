import { dashboardQueries } from "@/infra/db/queries";
import { json, workspaceRoute } from "../../../_lib/http";

export const dynamic = "force-dynamic";

export const GET = workspaceRoute({}, async ({ req, scope, requestId }) => {
  const hours = Math.min(168, Math.max(1, Number(new URL(req.url).searchParams.get("hours") ?? "24") || 24));
  return json({ summary: await dashboardQueries.observability(scope, hours) }, requestId);
});
