"use client";

import { KeyRound, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "../toast";
import { api, ApiError } from "../api";
import { Modal } from "../overlays";
import { Badge, Button, Card, Field, Input } from "../primitives";

type Kind = "slack" | "discord";
type Integration = { kind: Kind; hint: string };
const LABEL: Record<Kind, string> = { slack: "Slack", discord: "Discord" };
const PLACEHOLDER: Record<Kind, string> = { slack: "https://hooks.slack.com/services/T…/B…/…", discord: "https://discord.com/api/webhooks/…" };

export function SettingsView({ workspace, role, initialIntegrations, canAdmin }: { workspace: { id: string; name: string }; role: string; initialIntegrations: Integration[]; canAdmin: boolean }) {
  const router = useRouter();
  const [integrations, setIntegrations] = React.useState(initialIntegrations);
  const [name, setName] = React.useState(workspace.name);
  const [savingName, setSavingName] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const isOwner = role === "owner";

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    setSavingName(true);
    try {
      await api(`/api/w/${workspace.id}`, { method: "PATCH", json: { name } });
      toast.success("Workspace renamed");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not rename.");
    } finally {
      setSavingName(false);
    }
  }
  async function destroy() {
    try {
      await api(`/api/w/${workspace.id}`, { method: "DELETE" });
      toast.success("Workspace deleted");
      router.replace("/app");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not delete.");
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-4 sm:p-8">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Settings</h1>
        <p className="mt-1 text-sm text-ink-2">You are <Badge>{role}</Badge> in this workspace.</p>
      </header>

      <section aria-labelledby="int-h" className="space-y-3">
        <div>
          <h2 id="int-h" className="text-lg font-semibold text-ink">Integrations</h2>
          <p className="mt-1 text-sm text-ink-2">Let the assistant post summaries to a channel when you ask it to. The webhook URL is encrypted at rest (AES-256-GCM, bound to this workspace) and is <b className="text-ink">never shown again</b> after saving.</p>
        </div>
        {(["slack", "discord"] as const).map((kind) => (
          <IntegrationCard key={kind} kind={kind} workspaceId={workspace.id} current={integrations.find((i) => i.kind === kind)} canAdmin={canAdmin} onChange={(i) => setIntegrations((all) => [...all.filter((x) => x.kind !== kind), ...(i ? [i] : [])])} />
        ))}
      </section>

      {isOwner ? (
        <>
          <section aria-labelledby="ws-h" className="space-y-3">
            <h2 id="ws-h" className="text-lg font-semibold text-ink">Workspace</h2>
            <Card className="p-4">
              <form onSubmit={rename} className="flex flex-wrap items-end gap-3">
                <div className="min-w-56 flex-1">
                  <Field label="Name" htmlFor="ws-rename"><Input id="ws-rename" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></Field>
                </div>
                <Button type="submit" variant="secondary" loading={savingName} disabled={!name.trim() || name === workspace.name}>Save name</Button>
              </form>
            </Card>
          </section>

          <section aria-labelledby="danger-h" className="space-y-3">
            <h2 id="danger-h" className="text-lg font-semibold text-bad">Danger zone</h2>
            <Card className="flex flex-wrap items-center justify-between gap-3 border-bad/30 p-4">
              <p className="max-w-md text-sm text-ink-2">Deleting a workspace permanently removes its documents, chunks, conversations, tasks, tool log and integrations.</p>
              <Button variant="danger" onClick={() => setConfirmDelete(true)}><Trash2 /> Delete workspace</Button>
            </Card>
          </section>
        </>
      ) : null}

      <Modal open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete this workspace?" description="This cannot be undone.">
        <Field label={`Type “${workspace.name}” to confirm`} htmlFor="del-confirm"><Input id="del-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></Field>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" disabled={typed !== workspace.name} onClick={() => void destroy()}><Trash2 /> Delete forever</Button>
        </div>
      </Modal>
    </div>
  );
}

function IntegrationCard({ kind, workspaceId, current, canAdmin, onChange }: { kind: Kind; workspaceId: string; current: Integration | undefined; canAdmin: boolean; onChange: (i: Integration | null) => void }) {
  const [url, setUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const r = await api<{ hint: string }>(`/api/w/${workspaceId}/integrations`, { method: "PUT", json: { kind, url: url.trim() } });
      setUrl(""); // the secret leaves the page immediately
      onChange({ kind, hint: r.hint });
      toast.success(`${LABEL[kind]} connected`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    try {
      await api(`/api/w/${workspaceId}/integrations`, { method: "DELETE", json: { kind } });
      onChange(null);
      toast(`${LABEL[kind]} disconnected`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not remove.");
    }
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-3">
        <KeyRound className="size-4 text-ink-3" aria-hidden />
        <h3 className="font-medium text-ink">{LABEL[kind]}</h3>
        {current ? <Badge tone="good">connected</Badge> : <Badge>not connected</Badge>}
        {current ? <span className="font-mono text-[12px] text-ink-3">{current.hint}</span> : null}
        {current && canAdmin ? <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void remove()}>Disconnect</Button> : null}
      </div>
      {canAdmin ? (
        <form onSubmit={save} className="mt-3 flex flex-wrap items-start gap-3">
          <div className="min-w-56 flex-1">
            <Field label={current ? "Replace webhook URL" : "Incoming webhook URL"} htmlFor={`hook-${kind}`} error={error}>
              <Input id={`hook-${kind}`} type="password" autoComplete="off" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={PLACEHOLDER[kind]} />
            </Field>
          </div>
          <Button type="submit" variant="secondary" className="mt-[26px]" loading={busy} disabled={!url.trim()}>{current ? "Replace" : "Connect"}</Button>
        </form>
      ) : (
        <p className="mt-2 text-sm text-ink-2">Only workspace admins can change integrations.</p>
      )}
    </Card>
  );
}
