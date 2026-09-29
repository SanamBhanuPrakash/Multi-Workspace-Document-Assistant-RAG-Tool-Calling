import type { Metadata } from "next";
import { canWrite } from "@/core/security/tenant";
import { dashboardQueries } from "@/infra/db/queries";
import { requireWorkspaceScope } from "@/infra/session";
import { TasksView } from "@/ui/tasks/tasks-view";

export const metadata: Metadata = { title: "Tasks" };
export const dynamic = "force-dynamic";

export default async function TasksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { scope } = await requireWorkspaceScope(id);
  return <TasksView workspaceId={scope.workspaceId} initial={await dashboardQueries.tasks(scope)} canWrite={canWrite(scope)} />;
}
