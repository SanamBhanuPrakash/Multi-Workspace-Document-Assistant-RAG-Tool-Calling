import type { Metadata } from "next";
import { canWrite } from "@/core/security/tenant";
import { toolCallRepo } from "@/infra/db/repositories";
import { requireWorkspaceScope } from "@/infra/session";
import { ActivityView } from "@/ui/activity/activity-view";

export const metadata: Metadata = { title: "Tool log" };
export const dynamic = "force-dynamic";

export default async function ActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { scope } = await requireWorkspaceScope(id);
  return <ActivityView workspaceId={scope.workspaceId} initial={await toolCallRepo.list(scope, 100)} canWrite={canWrite(scope)} />;
}
