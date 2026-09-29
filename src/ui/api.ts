/** Client-side API helpers (browser only). Same-origin fetch: the session cookie is httpOnly, so no token ever touches JS. */

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; requestId?: string } };
    return new ApiError(body.error?.code ?? "error", body.error?.message ?? "Request failed.", res.status, body.error?.requestId);
  } catch {
    return new ApiError("error", "Request failed.", res.status);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    credentials: "same-origin",
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

export type StreamEvent = { type: string; [k: string]: unknown };

/**
 * POST + Server-Sent Events. (EventSource cannot POST, so we parse the stream ourselves.)
 * Errors refused before streaming starts (rate limit, validation) reject with ApiError; later failures arrive as `error` events.
 */
export async function streamPost(path: string, json: unknown, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(json),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) throw await toError(res);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) {
        try {
          onEvent(JSON.parse(data) as StreamEvent);
        } catch {
          /* ignore a malformed frame rather than killing the stream */
        }
      }
    }
  }
}

export const newRequestId = (): string => crypto.randomUUID();
