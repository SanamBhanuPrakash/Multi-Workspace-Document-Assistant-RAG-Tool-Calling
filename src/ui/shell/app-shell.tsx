"use client";

import { BarChart3, Check, ChevronsUpDown, CheckSquare, FileText, LogOut, MessageSquare, Moon, Plus, ScanSearch, Search, Settings, Sun, Wrench } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";
import { authClient } from "../auth-client";
import { api, ApiError } from "../api";
import { cn } from "../cn";
import { Logo } from "../logo";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Modal } from "../overlays";
import { Badge, Button, Field, Input, Kbd, WsDot } from "../primitives";
import { useTheme } from "../use-persisted";
import { CommandPalette } from "./command-palette";

export type ShellWorkspace = { id: string; name: string; color: string; role: string };

const NAV = [
  { href: "", label: "Chat", icon: MessageSquare },
  { href: "/documents", label: "Documents", icon: FileText },
  { href: "/activity", label: "Tool log", icon: Wrench },
  { href: "/tasks", label: "Tasks", icon: CheckSquare },
  { href: "/inspector", label: "Retrieval", icon: ScanSearch },
  { href: "/insights", label: "Insights", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function AppShell({ user, workspaces, active, children }: { user: { name: string; email: string }; workspaces: ShellWorkspace[]; active: ShellWorkspace; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { theme, toggle } = useTheme();
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const base = `/w/${active.id}`;

  React.useEffect(() => {
    document.cookie = `lattice_last_ws=${active.id}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  }, [active.id]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const signOut = React.useCallback(async () => {
    await authClient.signOut();
    router.replace("/login");
    router.refresh();
  }, [router]);

  const isActive = (href: string) => (href === "" ? pathname === base : pathname.startsWith(base + href));

  return (
    <div className="flex min-h-dvh flex-col" style={{ ["--ws" as string]: active.color }}>
      {/* identity band: the active tenant's colour is always visible */}
      <div className="h-[3px] w-full bg-ws" aria-hidden />
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-panel/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-panel/70 sm:px-4">
        <Link href="/app" aria-label="Lattice home" className="mr-1 hidden sm:block">
          <Logo />
        </Link>
        <Menu>
          <MenuTrigger asChild>
            <button className="flex h-9 max-w-[60vw] items-center gap-2 rounded-md border border-line-strong bg-panel px-2.5 text-sm font-medium text-ink hover:bg-panel-2 sm:max-w-64" aria-label={`Workspace: ${active.name}. Switch workspace`}>
              <WsDot color={active.color} />
              <span className="truncate">{active.name}</span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-ink-3" aria-hidden />
            </button>
          </MenuTrigger>
          <MenuContent align="start" className="w-72">
            <MenuLabel>Workspaces</MenuLabel>
            {workspaces.map((w) => (
              <MenuItem key={w.id} onSelect={() => router.push(`/w/${w.id}`)}>
                <WsDot color={w.color} />
                <span className="flex-1 truncate">{w.name}</span>
                {w.id === active.id ? <Check aria-label="Current" className="!text-brand" /> : <Badge>{w.role}</Badge>}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onSelect={() => setCreating(true)}>
              <Plus /> New workspace
            </MenuItem>
          </MenuContent>
        </Menu>
        <Badge tone="good" className="hidden md:inline-flex" title="Every query and every stored row is filtered to this workspace inside the database">
          <span className="size-1.5 rounded-full bg-good" aria-hidden /> sealed
        </Badge>

        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={() => setPaletteOpen(true)} className="hidden h-9 items-center gap-2 rounded-md border border-line bg-panel-2 px-2.5 text-sm text-ink-2 hover:text-ink sm:flex" aria-label="Open command palette">
            <Search className="size-3.5" aria-hidden />
            <span>Jump to…</span>
            <Kbd>⌘K</Kbd>
          </button>
          <Button variant="ghost" size="icon" onClick={toggle} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
          <Menu>
            <MenuTrigger asChild>
              <button className="grid size-9 place-items-center rounded-full border border-line-strong bg-panel-2 text-[13px] font-semibold text-ink hover:bg-panel-3" aria-label="Account menu">
                {(user.name || user.email).slice(0, 1).toUpperCase()}
              </button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuLabel>{user.email}</MenuLabel>
              <MenuItem onSelect={() => void signOut()}>
                <LogOut /> Sign out
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label="Workspace sections" className="shrink-0 border-b border-line bg-panel md:w-56 md:border-b-0 md:border-r">
          <ul className="flex gap-1 overflow-x-auto p-2 md:sticky md:top-[59px] md:flex-col md:overflow-visible md:p-3">
            {NAV.map(({ href, label, icon: Icon }) => (
              <li key={label} className="shrink-0">
                <Link
                  href={`${base}${href}`}
                  aria-current={isActive(href) ? "page" : undefined}
                  className={cn("flex h-10 items-center gap-2.5 rounded-md px-3 text-sm font-medium transition-colors", isActive(href) ? "bg-brand-soft text-brand" : "text-ink-2 hover:bg-panel-2 hover:text-ink")}
                >
                  <Icon className="size-4" aria-hidden />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" className="min-w-0 flex-1">
          {children}
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} workspaces={workspaces} active={active} base={base} nav={NAV.map((n) => ({ label: n.label, href: `${base}${n.href}` }))} onTheme={toggle} onSignOut={() => void signOut()} onNewWorkspace={() => setCreating(true)} />
      <NewWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function NewWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { workspace } = await api<{ workspace: { id: string } }>("/api/workspaces", { method: "POST", json: { name } });
      onOpenChange(false);
      setName("");
      toast.success("Workspace created");
      router.push(`/w/${workspace.id}/documents`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the workspace.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="New workspace" description="A workspace is a sealed knowledge space: its documents, chats, tasks and tool log are invisible to every other workspace.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" htmlFor="ws-name" error={error}>
          <Input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Legal, Q3 research" autoFocus required />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
            Create workspace
          </Button>
        </div>
      </form>
    </Modal>
  );
}
