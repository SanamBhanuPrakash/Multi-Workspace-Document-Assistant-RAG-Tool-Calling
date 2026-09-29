import type { Metadata } from "next";
import { canAdminister } from "@/core/security/tenant";
import { integrationRepo } from "@/infra/db/repositories";
import { workspaceRepo } from "@/infra/db/queries";
import { requireWorkspaceScope } from "@/infra/session";
import { SettingsView } from "@/ui/settings/settings-view";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { scope } = await requireWorkspaceScope(id);
  const [ws, integrations] = await Promise.all([workspaceRepo.get(scope), integrationRepo.list(scope)]);
  return <SettingsView workspace={{ id: scope.workspaceId, name: ws!.name }} role={scope.role} initialIntegrations={integrations} canAdmin={canAdminister(scope)} />;
}
