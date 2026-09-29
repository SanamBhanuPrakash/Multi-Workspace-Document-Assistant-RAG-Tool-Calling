import { z } from "zod";
import { askQuestion } from "@/core/application/ask";
import { askDeps } from "@/infra/container";
import { readJson, workspaceRoute } from "../../../_lib/http";
import { sseResponse } from "../../../_lib/sse";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.strictObject({
  message: z.string().min(1).max(4000),
  conversationId: z.uuid().optional(),
  /** Client-generated per send: makes retries and double-submits idempotent. */
  clientRequestId: z.string().min(8).max(100),
});

/** POST → Server-Sent Events: turn, retrieval, token*, tool*, done | error. */
export const POST = workspaceRoute({ mutating: true }, async ({ req, scope, requestId }) => {
  const body = await readJson(req, Body, 16_384);
  const gen = askQuestion(askDeps(), scope, { text: body.message, clientRequestId: body.clientRequestId, conversationId: body.conversationId, signal: req.signal });
  return sseResponse(gen, requestId);
});
