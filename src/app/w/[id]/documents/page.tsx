import type { Metadata } from "next";
import { canAdminister, canWrite } from "@/core/security/tenant";
import { documentRepo, shareRepo } from "@/infra/db/repositories";
import { workspaceRepo } from "@/infra/db/queries";
import { requireWorkspaceScope } from "@/infra/session";
import { DocumentsView } from "@/ui/documents/documents-view";

export const metadata: Metadata = { title: "Documents" };
export const dynamic = "force-dynamic";

export default async function DocumentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, scope } = await requireWorkspaceScope(id);
  const [docs, shares, all] = await Promise.all([documentRepo.list(scope), shareRepo.outgoing(scope), workspaceRepo.listForUser(user.id)]);
  return (
    <DocumentsView
      workspaceId={scope.workspaceId}
      initialDocs={docs}
      initialShares={shares}
      others={all.filter((w) => w.id !== scope.workspaceId).map((w) => ({ id: w.id, name: w.name, color: w.color }))}
      canWrite={canWrite(scope)}
      canAdmin={canAdminister(scope)}
    />
  );
}
