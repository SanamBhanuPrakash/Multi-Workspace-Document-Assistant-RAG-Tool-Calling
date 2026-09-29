import type { z } from "zod";
import { sha256Hex } from "../../domain/text";
import type { RetrievedChunk, ToolCallDTO, ToolCallStatus } from "../../domain/types";
import type { ToolCallRepo } from "../../ports/repositories";
import { canWrite, type TenantScope } from "../../security/tenant";
import { ToolError, type ToolDefinition, type ToolDeps, type ToolRegistry } from "./registry";

export type ExecutorDeps = { registry: ToolRegistry; calls: ToolCallRepo; toolDeps: ToolDeps; timeoutMs?: number };

export type ToolExecution = {
  callId: string;
  name: string;
  status: ToolCallStatus;
  /** What the MODEL is told. Always a JSON string; never contains stack traces, secrets or foreign-tenant data. */
  modelText: string;
  sources?: RetrievedChunk[];
  errorCode?: string;
};

const MAX_ARGS_BYTES = 8_192;

/** Stable JSON (sorted keys) so semantically identical arguments always hash to the same idempotency key. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

const reply = (ok: boolean, body: Record<string, unknown>): string => JSON.stringify(ok ? { ok: true, ...body } : { ok: false, ...body });

/** Compact, value-free description of why a Zod parse failed. Field paths only: never echoes attacker-controlled values. */
function describeIssues(err: z.ZodError): string {
  const parts = err.issues.slice(0, 5).map((i) => {
    const path = i.path.join(".") || "(arguments)";
    return i.code === "unrecognized_keys" ? `${path}: unknown field(s) not allowed` : `${path}: ${i.message}`;
  });
  return parts.join("; ");
}

function parseRawArgs(rawArgs: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (rawArgs.length > MAX_ARGS_BYTES) return { ok: false, reason: "arguments too large" };
  try {
    const v: unknown = rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
    // Some providers double-encode: a JSON string containing JSON. Accept exactly one level, then require an object.
    const unwrapped = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
    if (unwrapped === null || typeof unwrapped !== "object" || Array.isArray(unwrapped)) return { ok: false, reason: "arguments must be a JSON object" };
    return { ok: true, value: unwrapped };
  } catch {
    return { ok: false, reason: "arguments are not valid JSON" };
  }
}

export type ExecuteInput = {
  scope: TenantScope;
  messageId: string;
  step: number;
  call: { id: string; name: string; rawArgs: string };
  /** True when flagged (possibly hostile) document text was in the model's context for this request. */
  tainted: boolean;
  signal?: AbortSignal;
};

/**
 * Run ONE model-proposed tool call. The order matters and never changes:
 *   1. record intent   2. unknown tool?   3. parse JSON   4. strict schema   5. authorise (role)
 *   6. idempotency     7. taint gate      8. run with timeout   9. record outcome
 * The model cannot: name an unregistered tool, add fields, choose the workspace, or make a call run twice.
 */
export async function executeToolCall(deps: ExecutorDeps, input: ExecuteInput): Promise<ToolExecution> {
  const { scope, call } = input;
  const tool = deps.registry.get(call.name);

  const rejected = async (code: string, message: string, key: string): Promise<ToolExecution> => {
    const { call: row } = await deps.calls.begin(scope, {
      messageId: input.messageId, step: input.step, toolName: call.name, rawArgs: call.rawArgs,
      status: "rejected", errorCode: code, errorMessage: message, idempotencyKey: key, tainted: input.tainted,
    });
    return { callId: row.id, name: call.name, status: "rejected", errorCode: code, modelText: reply(false, { error: { code, message } }) };
  };

  const rawKey = await sha256Hex(`${input.messageId}|${input.step}|${call.name}|${call.rawArgs}`);

  if (!tool) return rejected("unknown_tool", `Tool "${sanitizeName(call.name)}" does not exist. Available tools: ${deps.registry.names().join(", ")}.`, `rej:${rawKey}`);

  const parsedJson = parseRawArgs(call.rawArgs);
  if (!parsedJson.ok) return rejected("malformed_arguments", parsedJson.reason, `rej:${rawKey}`);

  const parsed = tool.args.safeParse(parsedJson.value);
  if (!parsed.success) return rejected("invalid_arguments", describeIssues(parsed.error), `rej:${rawKey}`);

  if (tool.effect !== "read" && !canWrite(scope)) return rejected("forbidden", "Your role in this workspace cannot perform this action.", `rej:${rawKey}`);

  // Idempotency: writes/external actions dedupe across retries of the same message; reads are per-step.
  const canonical = canonicalJson(parsed.data);
  const key = await sha256Hex(`${input.messageId}|${tool.effect === "read" ? input.step : "*"}|${tool.name}|${canonical}`);

  const gated = tool.effect !== "read" && input.tainted;
  const { call: row, created } = await deps.calls.begin(scope, {
    messageId: input.messageId, step: input.step, toolName: tool.name, rawArgs: call.rawArgs,
    validatedArgs: parsed.data, status: gated ? "awaiting_confirmation" : "running", idempotencyKey: key, tainted: input.tainted,
  });

  if (!created) return replayExisting(row);

  if (gated) {
    return {
      callId: row.id, name: tool.name, status: "awaiting_confirmation",
      modelText: reply(false, {
        pending: true,
        message: "This action was NOT performed. It needs explicit confirmation from the user because retrieved documents contained suspicious instructions. Tell the user it is awaiting their confirmation.",
      }),
    };
  }

  return runTool(deps, scope, tool, row.id, parsed.data, input.signal);
}

/** Execute an already-validated call. Shared by the live path and by explicit human confirmation. */
async function runTool(deps: ExecutorDeps, scope: TenantScope, tool: ToolDefinition, callId: string, args: unknown, outer?: AbortSignal): Promise<ToolExecution> {
  const started = Date.now();
  const ac = new AbortController();
  let timedOut = false; // the timer is authoritative: a tool reacting to the abort signal must not mask the real cause
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, deps.timeoutMs ?? 10_000);
  const onOuter = () => ac.abort();
  outer?.addEventListener("abort", onOuter, { once: true });
  try {
    const outcome = await Promise.race([
      tool.run({ scope, toolCallId: callId, deps: deps.toolDeps, signal: ac.signal }, args),
      new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(new ToolError("timeout", "The tool timed out.")), { once: true })),
    ]);
    const latencyMs = Date.now() - started;
    await deps.calls.finish(scope, callId, { status: "succeeded", result: outcome.result, latencyMs });
    return { callId, name: tool.name, status: "succeeded", modelText: reply(true, { result: outcome.result }), ...(outcome.sources ? { sources: outcome.sources } : {}) };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const known = err instanceof ToolError;
    const code = timedOut ? "timeout" : known ? err.code : "internal_error";
    const message = timedOut ? "The tool timed out." : known ? err.message : "The tool failed unexpectedly."; // internal detail is logged by the caller, not shown
    await deps.calls.finish(scope, callId, { status: "failed", errorCode: code, errorMessage: message, latencyMs });
    return { callId, name: tool.name, status: "failed", errorCode: code, modelText: reply(false, { error: { code, message } }) };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuter);
  }
}

function replayExisting(row: ToolCallDTO): ToolExecution {
  const base = { callId: row.id, name: row.toolName, status: row.status };
  switch (row.status) {
    case "succeeded":
      return { ...base, modelText: reply(true, { result: row.result, deduplicated: true }) };
    case "awaiting_confirmation":
      return { ...base, modelText: reply(false, { pending: true, message: "This exact action is already awaiting the user's confirmation." }) };
    case "running":
      return { ...base, modelText: reply(false, { error: { code: "in_progress", message: "This exact action is already in progress." } }) };
    default:
      return { ...base, errorCode: row.errorCode ?? "failed", modelText: reply(false, { error: { code: row.errorCode ?? "failed", message: row.errorMessage ?? "This action failed earlier." } }) };
  }
}

const sanitizeName = (n: string): string => n.replace(/[^\w.-]/g, "?").slice(0, 60);

/**
 * Human decision on a call held by the taint gate. Only THIS path can release a gated call, and it is invoked from an
 * authenticated request by a workspace member — never from model output.
 */
export async function resolveConfirmation(deps: ExecutorDeps, scope: TenantScope, callId: string, decision: "confirm" | "decline"): Promise<ToolExecution> {
  const row = await deps.calls.get(scope, callId);
  if (!row) return { callId, name: "unknown", status: "rejected", errorCode: "not_found", modelText: reply(false, { error: { code: "not_found", message: "Tool call not found." } }) };
  if (row.status !== "awaiting_confirmation") return replayExisting(row); // already resolved: idempotent

  if (decision === "decline") {
    await deps.calls.finish(scope, callId, { status: "declined", errorCode: "declined_by_user", errorMessage: "The user declined this action.", confirmedBy: scope.userId });
    return { callId, name: row.toolName, status: "declined", modelText: reply(false, { error: { code: "declined_by_user", message: "The user declined this action." } }) };
  }

  const tool = deps.registry.get(row.toolName);
  if (!tool || !canWrite(scope)) return { callId, name: row.toolName, status: "rejected", errorCode: "forbidden", modelText: reply(false, { error: { code: "forbidden", message: "Not permitted." } }) };
  // Re-validate the stored arguments: never trust a database row as already-clean input.
  const reparsed = tool.args.safeParse(row.validatedArgs);
  if (!reparsed.success) return { callId, name: row.toolName, status: "rejected", errorCode: "invalid_arguments", modelText: reply(false, { error: { code: "invalid_arguments", message: describeIssues(reparsed.error) } }) };

  await deps.calls.finish(scope, callId, { status: "running", confirmedBy: scope.userId });
  return runTool(deps, scope, tool, callId, reparsed.data);
}
