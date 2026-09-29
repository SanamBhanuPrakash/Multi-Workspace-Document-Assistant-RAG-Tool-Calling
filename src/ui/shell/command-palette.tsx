"use client";

import { Command } from "cmdk";
import { Dialog } from "radix-ui";
import { CornerDownLeft, LogOut, Moon, Plus, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { WsDot } from "../primitives";
import type { ShellWorkspace } from "./app-shell";

const item = "flex h-10 cursor-pointer items-center gap-3 rounded-md px-3 text-sm text-ink-2 data-[selected=true]:bg-panel-2 data-[selected=true]:text-ink [&_svg]:size-4";

export function CommandPalette({ open, onOpenChange, workspaces, active, nav, onTheme, onSignOut, onNewWorkspace }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaces: ShellWorkspace[];
  active: ShellWorkspace;
  base: string;
  nav: { label: string; href: string }[];
  onTheme: () => void;
  onSignOut: () => void;
  onNewWorkspace: () => void;
}) {
  const router = useRouter();
  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-[14vh] z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-panel shadow-2 outline-none">
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Dialog.Description className="sr-only">Search for a workspace, page, or action.</Dialog.Description>
          <Command label="Command palette" loop>
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Search className="size-4 text-ink-3" aria-hidden />
              <Command.Input autoFocus placeholder="Switch workspace, jump to a page…" className="h-12 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-3 sm:text-sm" />
            </div>
            <Command.List className="pane-scroll max-h-[50vh] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-8 text-center text-sm text-ink-2">Nothing matches.</Command.Empty>
              <Command.Group heading="Workspaces" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-3">
                {workspaces.map((w) => (
                  <Command.Item key={w.id} value={`workspace ${w.name}`} onSelect={run(() => router.push(`/w/${w.id}`))} className={item}>
                    <WsDot color={w.color} /> {w.name}
                    {w.id === active.id ? <span className="ml-auto text-xs text-ink-3">current</span> : null}
                  </Command.Item>
                ))}
                <Command.Item value="new workspace create" onSelect={run(onNewWorkspace)} className={item}>
                  <Plus /> New workspace
                </Command.Item>
              </Command.Group>
              <Command.Group heading="Go to" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-3">
                {nav.map((n) => (
                  <Command.Item key={n.href} value={`go ${n.label}`} onSelect={run(() => router.push(n.href))} className={item}>
                    <CornerDownLeft /> {n.label}
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group heading="Actions" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-3">
                <Command.Item value="toggle theme dark light" onSelect={run(onTheme)} className={item}>
                  <Moon /> Toggle theme
                </Command.Item>
                <Command.Item value="sign out log out" onSelect={run(onSignOut)} className={item}>
                  <LogOut /> Sign out
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
