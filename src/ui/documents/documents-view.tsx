"use client";

import { AlertTriangle, CheckCircle2, CloudUpload, FileText, Loader2, RotateCcw, Share2, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import type { DocumentDTO } from "@/core/domain/types";
import { api, ApiError } from "../api";
import { cn } from "../cn";
import { Modal } from "../overlays";
import { Badge, Button, EmptyState, WsDot } from "../primitives";

type Share = { documentId: string; targetWorkspaceId: string };
type OtherWs = { id: string; name: string; color: string };
type UploadResult = { filename: string; outcome: "created" | "duplicate" | "rejected"; error?: { message: string } };

const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const ACCEPT = ".pdf,.docx,.md,.markdown,.txt,application/pdf,text/plain,text/markdown";

export function DocumentsView({ workspaceId, initialDocs, initialShares, others, canWrite, canAdmin }: { workspaceId: string; initialDocs: DocumentDTO[]; initialShares: Share[]; others: OtherWs[]; canWrite: boolean; canAdmin: boolean }) {
  const [docs, setDocs] = React.useState(initialDocs);
  const [shares, setShares] = React.useState(initialShares);
  const [uploading, setUploading] = React.useState(false);
  const [drag, setDrag] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState<DocumentDTO | null>(null);
  const [shareDoc, setShareDoc] = React.useState<DocumentDTO | null>(null);
  const input = React.useRef<HTMLInputElement>(null);

  const refresh = React.useCallback(async () => {
    try {
      const r = await api<{ documents: DocumentDTO[]; shares: Share[] }>(`/api/w/${workspaceId}/documents`);
      setDocs(r.documents);
      setShares(r.shares);
    } catch {
      /* transient: the next poll retries */
    }
  }, [workspaceId]);

  const inFlight = docs.some((d) => d.status === "queued" || d.status === "processing");
  React.useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => void refresh(), 2500);
    return () => clearInterval(t);
  }, [inFlight, refresh]);

  const upload = React.useCallback(
    async (files: File[]) => {
      if (!files.length || !canWrite) return;
      setUploading(true);
      try {
        const body = new FormData();
        files.slice(0, 5).forEach((f) => body.append("files", f));
        const res = await fetch(`/api/w/${workspaceId}/documents`, { method: "POST", body, credentials: "same-origin" });
        if (!res.ok) {
          const e = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new ApiError("upload", e?.error?.message ?? "Upload failed.", res.status);
        }
        const { results } = (await res.json()) as { results: UploadResult[] };
        for (const r of results) {
          if (r.outcome === "created") toast.success(`${r.filename}: uploaded — indexing…`);
          else if (r.outcome === "duplicate") toast(`${r.filename}: already in this workspace`, { description: "Identical content was detected, so nothing was duplicated." });
          else toast.error(`${r.filename}: ${r.error?.message ?? "rejected"}`);
        }
        if (files.length > 5) toast("Only the first 5 files were uploaded.");
        await refresh();
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : "Upload failed. Check your connection.");
      } finally {
        setUploading(false);
        if (input.current) input.current.value = "";
      }
    },
    [canWrite, refresh, workspaceId],
  );

  async function retry(d: DocumentDTO) {
    try {
      await api(`/api/w/${workspaceId}/documents/${d.id}/retry`, { method: "POST" });
      toast("Retrying — resuming where it stopped");
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Retry failed.");
    }
  }
  async function remove(d: DocumentDTO) {
    try {
      await api(`/api/w/${workspaceId}/documents/${d.id}`, { method: "DELETE" });
      setDocs((all) => all.filter((x) => x.id !== d.id));
      toast.success("Document and its chunks deleted");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Delete failed.");
    } finally {
      setConfirmDelete(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Documents</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-2">Uploaded files are split into chunks, embedded, and stored in this workspace only. Re-uploading identical content never creates duplicates.</p>
        </div>
        {canWrite ? (
          <Button variant="primary" onClick={() => input.current?.click()} loading={uploading}>
            <CloudUpload /> Upload documents
          </Button>
        ) : null}
      </header>

      {canWrite ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            void upload([...e.dataTransfer.files]);
          }}
          className={cn("rounded-xl border-2 border-dashed p-8 text-center transition-colors", drag ? "border-brand bg-brand-soft" : "border-line-strong bg-panel")}
        >
          <input ref={input} type="file" multiple accept={ACCEPT} className="sr-only" aria-label="Choose files to upload" onChange={(e) => void upload([...(e.target.files ?? [])])} />
          <CloudUpload className="mx-auto size-7 text-ink-3" aria-hidden />
          <p className="mt-2 text-sm text-ink">
            Drag files here or{" "}
            <button type="button" onClick={() => input.current?.click()} className="font-medium text-brand underline-offset-4 hover:underline">
              browse
            </button>
          </p>
          <p className="mt-1 text-xs text-ink-3">PDF, DOCX, Markdown or text · up to 5 MB each · 5 files at a time</p>
        </div>
      ) : null}

      {docs.length === 0 ? (
        <div className="rounded-xl border border-line bg-panel">
          <EmptyState icon={<FileText />} title="No documents yet">
            Upload at least two documents to try grounded answers, then switch to another workspace and confirm none of it is visible there.
          </EmptyState>
        </div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel" aria-label="Documents">
          {docs.map((d) => {
            const mine = d.sharedFromWorkspaceId === null;
            const sharedTo = shares.filter((s) => s.documentId === d.id);
            return (
              <li key={d.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-line bg-panel-2 text-ink-2">
                  <FileText className="size-5" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-medium text-ink">{d.title}</p>
                    <StatusBadge doc={d} />
                    {d.flaggedChunkCount > 0 ? (
                      <Badge tone="warn" title="The ingestion scanner found text that looks like instructions aimed at an AI. It is still searchable, but treated strictly as data and any action it triggers needs your approval.">
                        <AlertTriangle className="size-3" aria-hidden /> {d.flaggedChunkCount} flagged
                      </Badge>
                    ) : null}
                    {!mine ? <Badge tone="brand">shared in · read-only</Badge> : null}
                    {sharedTo.length ? <Badge tone="brand">shared with {sharedTo.length}</Badge> : null}
                  </div>
                  <p className="mt-0.5 text-[13px] text-ink-3">
                    {d.filename} · {fmtSize(d.sizeBytes)} · {d.chunkCount} chunk{d.chunkCount === 1 ? "" : "s"} · {new Date(d.createdAt).toLocaleDateString()}
                  </p>
                  {d.status === "failed" && d.error ? <p className="mt-1 text-[13px] text-bad">{d.error}</p> : null}
                </div>
                {mine && canWrite ? (
                  <div className="flex shrink-0 items-center gap-1">
                    {(d.status === "failed" || d.status === "queued") ? (
                      <Button variant="secondary" size="sm" onClick={() => void retry(d)}>
                        <RotateCcw /> {d.status === "failed" ? "Retry" : "Resume"}
                      </Button>
                    ) : null}
                    {canAdmin && d.status === "ready" && others.length ? (
                      <Button variant="ghost" size="sm" onClick={() => setShareDoc(d)}>
                        <Share2 /> Share
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="icon" onClick={() => setConfirmDelete(d)} aria-label={`Delete ${d.title}`}>
                      <Trash2 />
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <Modal open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)} title="Delete this document?" description="Its chunks are removed from search immediately. Past answers keep their quoted snippets.">
        <p className="mb-5 rounded-md border border-line bg-panel-2 p-3 text-sm text-ink">{confirmDelete?.title}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => confirmDelete && void remove(confirmDelete)}>
            <Trash2 /> Delete
          </Button>
        </div>
      </Modal>

      <ShareDialog doc={shareDoc} others={others} shares={shares} workspaceId={workspaceId} onClose={() => setShareDoc(null)} onChanged={refresh} />
    </div>
  );
}

function StatusBadge({ doc }: { doc: DocumentDTO }) {
  switch (doc.status) {
    case "ready":
      return <Badge tone="good"><CheckCircle2 className="size-3" aria-hidden /> Ready</Badge>;
    case "failed":
      return <Badge tone="bad">Failed</Badge>;
    case "processing":
      return <Badge tone="brand"><Loader2 className="size-3 animate-spin" aria-hidden /> Indexing</Badge>;
    default:
      return <Badge><Loader2 className="size-3 animate-spin" aria-hidden /> Queued</Badge>;
  }
}

function ShareDialog({ doc, others, shares, workspaceId, onClose, onChanged }: { doc: DocumentDTO | null; others: OtherWs[]; shares: Share[]; workspaceId: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  async function toggle(target: OtherWs, on: boolean) {
    if (!doc) return;
    setBusy(target.id);
    try {
      await api(`/api/w/${workspaceId}/documents/${doc.id}/share`, { method: on ? "POST" : "DELETE", json: { targetWorkspaceId: target.id } });
      toast.success(on ? `Shared with ${target.name} (read-only)` : `Stopped sharing with ${target.name}`);
      await onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not change sharing.");
    } finally {
      setBusy(null);
    }
  }
  return (
    <Modal open={!!doc} onOpenChange={(o) => !o && onClose()} title="Share document" description="Sharing is opt-in and read-only: the other workspace can search and cite this document but never edit or delete it. Revoking takes effect immediately.">
      <ul className="space-y-2">
        {others.map((w) => {
          const on = !!doc && shares.some((s) => s.documentId === doc.id && s.targetWorkspaceId === w.id);
          return (
            <li key={w.id} className="flex items-center gap-3 rounded-lg border border-line p-3">
              <WsDot color={w.color} />
              <span className="flex-1 truncate text-sm text-ink">{w.name}</span>
              <Button size="sm" variant={on ? "secondary" : "primary"} loading={busy === w.id} disabled={busy !== null} onClick={() => void toggle(w, !on)}>
                {on ? "Stop sharing" : "Share"}
              </Button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
