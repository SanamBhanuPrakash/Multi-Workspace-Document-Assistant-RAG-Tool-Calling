import "server-only";
import type { AskEvent } from "@/core/application/ask";
import { errorResponse } from "./http";

/**
 * Turn the orchestrator's event stream into Server-Sent Events.
 * Errors thrown BEFORE the first event (validation, rate limit, auth-adjacent) become a normal 4xx JSON response, so the
 * client never has to parse a stream to learn its request was refused. After the first event, failures are `error` events.
 */
export async function sseResponse(gen: AsyncGenerator<AskEvent>, requestId: string): Promise<Response> {
  let first: IteratorResult<AskEvent>;
  try {
    first = await gen.next();
  } catch (err) {
    return errorResponse(err, requestId);
  }

  const enc = new TextEncoder();
  const frame = (e: AskEvent) => enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          /* stream already closed */
        }
      }, 10_000);
      try {
        if (!first.done) controller.enqueue(frame(first.value));
        if (!first.done) {
          for await (const ev of gen) controller.enqueue(frame(ev));
        }
      } catch {
        controller.enqueue(frame({ type: "error", code: "internal", message: "The stream ended unexpectedly.", retryable: true, assistantMessageId: "" }));
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed by cancel */
        }
      }
    },
    async cancel() {
      await gen.return(undefined); // reader went away: triggers the orchestrator's finally (marks the reply failed/aborted)
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-request-id": requestId,
    },
  });
}
