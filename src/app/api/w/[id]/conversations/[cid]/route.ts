import { notFound } from "@/core/domain/errors";
import { isUuid } from "@/core/security/tenant";
import { dashboardQueries } from "@/infra/db/queries";
import { json, workspaceRoute } from "../../../../_lib/http";

export const dynamic = "force-dynamic";

type P = { id: string; cid: string };

export const GET = workspaceRoute<P>({}, async ({ scope, params, requestId }) => {
  if (!isUuid(params.cid)) throw notFound("Conversation");
  const messages = await dashboardQueries.messages(scope, params.cid);
  if (messages.length === 0) throw notFound("Conversation");
  const toolCalls = await dashboardQueries.toolCallsForMessages(scope, messages.filter((m) => m.role === "assistant").map((m) => m.id));
  return json({ messages, toolCalls }, requestId);
});
