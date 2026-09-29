import { notFound } from "next/navigation";
import { workspaceRepo } from "@/infra/db/queries";
import { requireWorkspaceScope } from "@/infra/session";
import { AppShell } from "@/ui/shell/app-shell";

export const dynamic = "force-dynamic";

export default async function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, scope } = await requireWorkspaceScope(id); // membership verified here on EVERY navigation
  const workspaces = await workspaceRepo.listForUser(user.id);
  const active = workspaces.find((w) => w.id === scope.workspaceId);
  if (!active) notFound();
  return (
    <AppShell user={user} workspaces={workspaces} active={active}>
      {children}
    </AppShell>
  );
}
