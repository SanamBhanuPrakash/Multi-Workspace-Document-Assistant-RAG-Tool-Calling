"use client";

import { CheckSquare } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import type { TaskDTO } from "@/core/domain/types";
import { api, ApiError } from "../api";
import { cn } from "../cn";
import { Badge, EmptyState } from "../primitives";

const TONE = { high: "bad", normal: "neutral", low: "neutral" } as const;

export function TasksView({ workspaceId, initial, canWrite }: { workspaceId: string; initial: TaskDTO[]; canWrite: boolean }) {
  const [tasks, setTasks] = React.useState(initial);
  async function toggle(t: TaskDTO) {
    const next = t.status === "open" ? "done" : "open";
    setTasks((all) => all.map((x) => (x.id === t.id ? { ...x, status: next } : x))); // optimistic
    try {
      await api(`/api/w/${workspaceId}/tasks`, { method: "PATCH", json: { taskId: t.id, status: next } });
    } catch (err) {
      setTasks((all) => all.map((x) => (x.id === t.id ? { ...x, status: t.status } : x)));
      toast.error(err instanceof ApiError ? err.message : "Could not update the task.");
    }
  }
  const open = tasks.filter((t) => t.status === "open");
  const done = tasks.filter((t) => t.status === "done");
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-8">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Tasks</h1>
        <p className="mt-1 text-sm text-ink-2">Saved by the assistant when you ask it to (for example “save a task: renew the vault code by Friday”). This list is private to this workspace.</p>
      </header>
      {tasks.length === 0 ? (
        <div className="rounded-xl border border-line bg-panel">
          <EmptyState icon={<CheckSquare />} title="No tasks yet">Ask in chat: “save a task: follow up on the refund policy”. It will show up here.</EmptyState>
        </div>
      ) : (
        <>
          <TaskList title={`Open · ${open.length}`} tasks={open} onToggle={toggle} canWrite={canWrite} />
          {done.length ? <TaskList title={`Done · ${done.length}`} tasks={done} onToggle={toggle} canWrite={canWrite} /> : null}
        </>
      )}
    </div>
  );
}

function TaskList({ title, tasks, onToggle, canWrite }: { title: string; tasks: TaskDTO[]; onToggle: (t: TaskDTO) => void; canWrite: boolean }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-3">{title}</h2>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-start gap-3 p-4">
            <input type="checkbox" checked={t.status === "done"} disabled={!canWrite} onChange={() => onToggle(t)} aria-label={`Mark "${t.title}" as ${t.status === "open" ? "done" : "open"}`} className="mt-1 size-4 cursor-pointer accent-[var(--brand)]" />
            <div className="min-w-0 flex-1">
              <p className={cn("font-medium text-ink", t.status === "done" && "text-ink-3 line-through")}>{t.title}</p>
              {t.description ? <p className="mt-0.5 text-sm text-ink-2">{t.description}</p> : null}
              <p className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
                {t.priority !== "normal" ? <Badge tone={TONE[t.priority]}>{t.priority}</Badge> : null}
                {t.dueDate ? <span>due {t.dueDate}</span> : null}
                <span>saved {new Date(t.createdAt).toLocaleDateString()}</span>
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
