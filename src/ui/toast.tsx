"use client";

import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import * as React from "react";
import { cn } from "./cn";

/**
 * Minimal, accessible toasts. Written in-house (instead of a library) because most toast libraries inject a <style> element
 * at runtime, which a strict CSP (style-src with a nonce) rightly blocks. This uses only Tailwind classes — nothing injected.
 * Errors use role="alert" (announced immediately); others use role="status" (polite).
 */
type Kind = "success" | "error" | "info";
type Item = { id: number; kind: Kind; text: string; description?: string | undefined };
type Opts = { description?: string };

const EMPTY: Item[] = [];
let items: Item[] = EMPTY;
let seq = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function dismiss(id: number) {
  items = items.filter((i) => i.id !== id);
  emit();
}
function push(kind: Kind, text: string, opts?: Opts) {
  const id = ++seq;
  items = [...items.slice(-3), { id, kind, text, description: opts?.description }];
  emit();
  setTimeout(() => dismiss(id), kind === "error" ? 8000 : 4500);
}

export const toast = Object.assign((text: string, opts?: Opts) => push("info", text, opts), {
  success: (text: string, opts?: Opts) => push("success", text, opts),
  error: (text: string, opts?: Opts) => push("error", text, opts),
  message: (text: string, opts?: Opts) => push("info", text, opts),
});

const ICON = { success: CheckCircle2, error: AlertCircle, info: Info } as const;
const TONE = { success: "text-good", error: "text-bad", info: "text-brand" } as const;

export function Toaster() {
  const list = React.useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => items,
    () => EMPTY,
  );
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 pb-[env(safe-area-inset-bottom)]">
      {list.map((t) => {
        const Icon = ICON[t.kind];
        return (
          <div key={t.id} role={t.kind === "error" ? "alert" : "status"} className="rise-in pointer-events-auto flex items-start gap-3 rounded-lg border border-line bg-panel p-3 pr-2 shadow-2">
            <Icon className={cn("mt-0.5 size-4 shrink-0", TONE[t.kind])} aria-hidden />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium text-ink">{t.text}</p>
              {t.description ? <p className="mt-0.5 text-[13px] text-ink-2">{t.description}</p> : null}
            </div>
            <button onClick={() => dismiss(t.id)} className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-panel-2 hover:text-ink" aria-label="Dismiss notification">
              <X className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
