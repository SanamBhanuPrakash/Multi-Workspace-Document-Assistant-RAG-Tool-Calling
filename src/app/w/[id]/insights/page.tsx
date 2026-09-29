import type { Metadata } from "next";
import { dashboardQueries } from "@/infra/db/queries";
import { requireWorkspaceScope } from "@/infra/session";
import { InsightsView } from "@/ui/insights/insights-view";

export const metadata: Metadata = { title: "Insights" };
export const dynamic = "force-dynamic";

export default async function InsightsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { scope } = await requireWorkspaceScope(id);
  return <InsightsView workspaceId={scope.workspaceId} initial={await dashboardQueries.observability(scope, 24)} />;
}
