import type { Metadata } from "next";
import { dashboardQueries, workspaceRepo } from "@/infra/db/queries";
import { requireWorkspaceScope } from "@/infra/session";
import { InspectorView } from "@/ui/inspector/inspector-view";

export const metadata: Metadata = { title: "Retrieval inspector" };
export const dynamic = "force-dynamic";

export default async function InspectorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { scope } = await requireWorkspaceScope(id);
  const [events, ws] = await Promise.all([dashboardQueries.recentRetrievals(scope, 20), workspaceRepo.get(scope)]);
  return <InspectorView workspace={{ id: scope.workspaceId, name: ws!.name, color: ws!.color }} events={events} />;
}
