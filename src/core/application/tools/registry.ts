import { z } from "zod";
import type { RetrievedChunk } from "../../domain/types";
import type { ToolDeclaration, NotifierPort } from "../../ports/providers";
import type { IntegrationRepo, TaskRepo } from "../../ports/repositories";
import type { TenantScope } from "../../security/tenant";

/** A failure whose message is safe to show to the model and the user. Anything else becomes a generic internal error. */
export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export type ToolDeps = {
  tasks: TaskRepo;
  integrations: IntegrationRepo;
  notifier: NotifierPort;
  /** Workspace-scoped retrieval; the scope is supplied by the executor, never by the model. */
  retrieve: (scope: TenantScope, query: string, limit: number) => Promise<RetrievedChunk[]>;
};

export type ToolContext = { scope: TenantScope; toolCallId: string; deps: ToolDeps; signal: AbortSignal };
export type ToolOutcome = { result: unknown; sources?: RetrievedChunk[] };

/**
 * effect:
 *  - "read"     no persistent change
 *  - "write"    changes state inside this workspace
 *  - "external" leaves the system (Slack/Discord)
 * Anything other than "read" is a SIDE EFFECT and is held for human confirmation when the request was tainted.
 */
export type ToolEffect = "read" | "write" | "external";

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly description: string;
  /** Must be a strictObject: unknown keys (e.g. a model-supplied workspace_id) are rejected, not ignored. */
  readonly args: S;
  readonly effect: ToolEffect;
  /**
   * True when the tool's output becomes CITABLE SOURCES (search_documents). Answers built on such a tool must still cite them;
   * only non-citable tools (actions, task lists) may support an uncited reply such as "Saved your task".
   */
  readonly citable?: boolean;
  run(ctx: ToolContext, args: z.output<S>): Promise<ToolOutcome>;
}

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDefinition>();
  constructor(defs: ToolDefinition[]) {
    for (const d of defs) {
      if (this.byName.has(d.name)) throw new Error(`duplicate tool: ${d.name}`);
      this.byName.set(d.name, d);
    }
  }
  /** Own-property lookup only: a model asking for "constructor" or "__proto__" gets undefined, not a prototype member. */
  get(name: string): ToolDefinition | undefined {
    return this.byName.get(name);
  }
  names(): string[] {
    return [...this.byName.keys()];
  }
  declarations(): ToolDeclaration[] {
    return [...this.byName.values()].map((d) => ({
      name: d.name,
      description: d.description,
      parameters: stripJsonSchemaNoise(z.toJSONSchema(d.args, { target: "draft-7", io: "input" })),
    }));
  }
}

function stripJsonSchemaNoise(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, ...rest } = schema;
  return rest;
}

/* ───────────────────────────── the tools ───────────────────────────── */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

export const saveTask: ToolDefinition = {
  name: "save_task",
  description:
    "Save a follow-up task into the CURRENT workspace's task list. Use only when the user explicitly asks to create/save/remember a task or to-do.",
  args: z.strictObject({
    title: z.string().trim().min(1).max(200).describe("Short task title"),
    description: z.string().trim().max(2000).optional().describe("Optional details"),
    priority: z.enum(["low", "normal", "high"]).default("normal"),
    due_date: isoDate.optional().describe("Optional due date, YYYY-MM-DD"),
  }),
  effect: "write",
  async run(ctx, args) {
    const a = args as { title: string; description?: string; priority: "low" | "normal" | "high"; due_date?: string };
    const task = await ctx.deps.tasks.create(ctx.scope, {
      title: a.title,
      description: a.description ?? null,
      priority: a.priority,
      dueDate: a.due_date ?? null,
      toolCallId: ctx.toolCallId,
    });
    return { result: { task_id: task.id, title: task.title, priority: task.priority, due_date: task.dueDate } };
  },
};

export const listTasks: ToolDefinition = {
  name: "list_tasks",
  description: "List tasks saved in the CURRENT workspace.",
  args: z.strictObject({
    status: z.enum(["open", "done", "all"]).default("open"),
    limit: z.number().int().min(1).max(20).default(10),
  }),
  effect: "read",
  async run(ctx, args) {
    const a = args as { status: "open" | "done" | "all"; limit: number };
    const tasks = await ctx.deps.tasks.list(ctx.scope, a.status, a.limit);
    return { result: { count: tasks.length, tasks: tasks.map((t) => ({ id: t.id, title: t.title, priority: t.priority, due_date: t.dueDate, status: t.status })) } };
  },
};

export const sendSummary: ToolDefinition = {
  name: "send_summary",
  description:
    "Post a short summary message to the workspace's configured Slack or Discord channel. Use only when the user explicitly asks to send/share/post a summary.",
  args: z.strictObject({
    channel: z.enum(["slack", "discord"]),
    title: z.string().trim().min(1).max(100),
    summary: z.string().trim().min(1).max(3000),
  }),
  effect: "external",
  async run(ctx, args) {
    const a = args as { channel: "slack" | "discord"; title: string; summary: string };
    const url = await ctx.deps.integrations.getWebhookUrl(ctx.scope, a.channel);
    if (!url) throw new ToolError("integration_not_configured", `No ${a.channel} webhook is configured for this workspace. A workspace owner can add one in Settings.`);
    await ctx.deps.notifier.send(a.channel, url, { title: a.title, body: a.summary }, ctx.signal);
    return { result: { delivered: true, channel: a.channel } };
  },
};

export const searchDocuments: ToolDefinition = {
  name: "search_documents",
  description:
    "Search the CURRENT workspace's documents for additional evidence. Use when the sources you were given are not enough and you need to look up a different topic.",
  args: z.strictObject({
    query: z.string().trim().min(2).max(300),
    limit: z.number().int().min(1).max(8).default(4),
  }),
  effect: "read",
  citable: true,
  async run(ctx, args) {
    const a = args as { query: string; limit: number };
    const sources = await ctx.deps.retrieve(ctx.scope, a.query, a.limit);
    return { result: { found: sources.length }, sources };
  },
};

export const defaultTools = (): ToolRegistry => new ToolRegistry([saveTask, listTasks, sendSummary, searchDocuments]);
