"use client";

import { Dialog as D, DropdownMenu as M, Tooltip as T } from "radix-ui";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "./cn";

/* Accessible overlays built on Radix primitives (focus trap, ESC, aria wiring, portal). */

export function Modal({ open, onOpenChange, title, description, children, className }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: React.ReactNode; className?: string }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px] data-[state=open]:animate-[rise_160ms_var(--ease-out)]" />
        <D.Content className={cn("fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-panel p-5 shadow-2 outline-none", className)}>
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <D.Title className="text-lg font-semibold text-ink">{title}</D.Title>
              {description ? <D.Description className="mt-1 text-sm text-ink-2">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
            </div>
            <D.Close className="grid size-8 place-items-center rounded-md text-ink-2 hover:bg-panel-2 hover:text-ink" aria-label="Close">
              <X className="size-4" />
            </D.Close>
          </div>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function Drawer({ open, onOpenChange, title, description, children }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: React.ReactNode }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/45" />
        <D.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-line bg-panel shadow-2 outline-none">
          <div className="flex items-start justify-between gap-4 border-b border-line p-5">
            <div>
              <D.Title className="text-base font-semibold text-ink">{title}</D.Title>
              {description ? <D.Description className="mt-1 text-sm text-ink-2">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
            </div>
            <D.Close className="grid size-8 place-items-center rounded-md text-ink-2 hover:bg-panel-2 hover:text-ink" aria-label="Close">
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="pane-scroll flex-1 overflow-y-auto p-5">{children}</div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;
export function MenuContent({ className, ...props }: React.ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content sideOffset={6} className={cn("z-50 min-w-56 rounded-lg border border-line bg-panel p-1.5 shadow-2 outline-none", className)} {...props} />
    </M.Portal>
  );
}
export function MenuItem({ className, ...props }: React.ComponentProps<typeof M.Item>) {
  return <M.Item className={cn("flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-ink outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-panel-2 [&_svg]:size-4 [&_svg]:text-ink-2", className)} {...props} />;
}
export const MenuLabel = ({ children }: { children: React.ReactNode }) => <M.Label className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-3">{children}</M.Label>;
export const MenuSeparator = () => <M.Separator className="my-1.5 h-px bg-line" />;

export function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <T.Provider delayDuration={250}>
      <T.Root>
        <T.Trigger asChild>{children}</T.Trigger>
        <T.Portal>
          <T.Content sideOffset={6} className="z-50 max-w-xs rounded-md border border-line bg-panel-3 px-2.5 py-1.5 text-xs text-ink shadow-2">
            {label}
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  );
}
