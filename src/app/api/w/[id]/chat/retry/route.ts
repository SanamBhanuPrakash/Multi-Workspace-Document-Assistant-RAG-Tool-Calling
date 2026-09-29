import { z } from "zod";
import { retryAnswer } from "@/core/application/ask";
import { askDeps } from "@/infra/container";
import { readJson, workspaceRoute } from "../../../../_lib/http";
import { sseResponse } from "../../../../_lib/sse";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.strictObject({ assistantMessageId: z.uuid() });

/** Re-run a failed (or stalled) reply against the SAME question. Never creates a duplicate user message. */
export const POST = workspaceRoute({ mutating: true }, async ({ req, scope, requestId }) => {
  const { assistantMessageId } = await readJson(req, Body);
  return sseResponse(retryAnswer(askDeps(), scope, assistantMessageId, req.signal), requestId);
});
