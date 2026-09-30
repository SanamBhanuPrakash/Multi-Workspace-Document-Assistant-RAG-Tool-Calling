import type { Metadata } from "next";
import { canWrite, isUuid } from "@/core/security/tenant";
import { documentRepo } from "@/infra/db/repositories";
import { dashboardQueries, workspaceRepo } from "@/infra/db/queries";
import { requireWorkspaceScope } from "@/infra/session";
import { ChatView } from "@/ui/chat/chat-view";

export const metadata: Metadata = { title: "Chat" };
export const dynamic = "force-dynamic";

export default async function ChatPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ c?: string }> }) {
  const { id } = await params;
  const { c } = await searchParams;
  const { scope } = await requireWorkspaceScope(id);
  const conversationId = c && isUuid(c) ? c : null;

  const [conversations, docs, messages] = await Promise.all([
    dashboardQueries.conversations(scope),
    documentRepo.list(scope),
    conversationId ? dashboardQueries.messages(scope, conversationId) : Promise.resolve([]),
  ]);
  const tools = messages.length ? await dashboardQueries.toolCallsForMessages(scope, messages.filter((m) => m.role === "assistant").map((m) => m.id)) : [];
  const workspace = (await workspaceRepo.get(scope))!;

  return (
    <ChatView
      key={workspace.id} // NOT keyed by conversation: ChatView adopts its own new conversation without remounting (see the sync block there)
      workspace={{ id: workspace.id, name: workspace.name, color: workspace.color }}
      conversations={conversations}
      conversationId={messages.length ? conversationId : null}
      initialMessages={messages}
      initialTools={tools.map((t) => ({ id: t.id, messageId: t.messageId, step: t.step, toolName: t.toolName, status: t.status, errorCode: t.errorCode, tainted: t.tainted }))}
      docTitles={docs.filter((d) => d.status === "ready").map((d) => d.title)}
      canWrite={canWrite(scope)}
    />
  );
}
