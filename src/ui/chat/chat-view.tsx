"use client";

import { AlertTriangle, ArrowDown, ArrowUp, Ban, Check, CheckCircle2, Copy, FileText, History, Loader2, MessageSquarePlus, RotateCcw, ScanSearch, ShieldAlert, Square, Wrench, X } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "../toast";
import type { Citation, MessageDTO, RetrievalEventDTO } from "@/core/domain/types";
import { api, ApiError, newRequestId, streamPost, type StreamEvent } from "../api";
import { cn } from "../cn";
import { Drawer } from "../overlays";
import { Badge, Button, EmptyState, Spinner, Textarea } from "../primitives";
import { sectionLabel } from "../section-label";
import { usePersisted } from "../use-persisted";
import { Markdown } from "./markdown";
import { RetrievalPanel } from "./retrieval-panel";

/* ───────────── types ───────────── */
export type ToolItem = { callId: string; name: string; status: string; step: number; message?: string | undefined; tainted?: boolean };
type SourceLite = { n: number; documentTitle: string; headingPath: string; ordinal: number; flagged: boolean; similarity: number | null };
type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "pending" | "streaming" | "complete" | "failed";
  errorCode?: string | null | undefined;
  retryable?: boolean | undefined;
  citations: Citation[];
  abstained: boolean;
  tools: ToolItem[];
  sources?: SourceLite[] | undefined;
  tainted?: boolean | undefined;
};
export type InitialTool = { id: string; messageId: string; step: number; toolName: string; status: string; errorCode: string | null; tainted: boolean };

const ERRORS: Record<string, string> = {
  provider_rate_limited: "The AI provider is rate-limiting requests right now.",
  provider_unavailable: "The AI provider is temporarily unavailable.",
  provider_blocked: "The AI provider declined to process this content.",
  timeout: "The AI provider took too long to respond.",
  aborted: "The response was interrupted.",
  stalled: "This answer never finished.",
  rate_limited: "You're sending messages too quickly.",
};

function fromServer(messages: MessageDTO[], tools: InitialTool[]): Msg[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    status: m.status,
    errorCode: m.errorCode,
    retryable: m.status === "failed",
    citations: m.citations,
    abstained: m.abstained,
    tools: tools.filter((t) => t.messageId === m.id).map((t) => ({ callId: t.id, name: t.toolName, status: t.status, step: t.step, message: t.errorCode ?? undefined, tainted: t.tainted })),
  }));
}

/* ───────────── component ───────────── */
export function ChatView({ workspace, conversations, conversationId: initialConversationId, initialMessages, initialTools, docTitles, canWrite }: {
  workspace: { id: string; name: string; color: string };
  conversations: { id: string; title: string; updatedAt: string }[];
  conversationId: string | null;
  initialMessages: MessageDTO[];
  initialTools: InitialTool[];
  docTitles: string[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [messages, setMessages] = React.useState<Msg[]>(() => fromServer(initialMessages, initialTools));
  const [conversationId, setConversationId] = React.useState(initialConversationId);
  const [input, setInput] = usePersisted(`lattice-draft:${workspace.id}`);
  const [busy, setBusy] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [source, setSource] = React.useState<{ msg: Msg; n: number } | null>(null);
  const [inspect, setInspect] = React.useState<{ messageId: string } | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const scroller = React.useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = React.useState(true);
  const taRef = React.useRef<HTMLTextAreaElement>(null);

  // Unsent text survives reloads and failed sends (see usePersisted: storage is optional, never required).
  React.useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [input]);

  const scrollToEnd = React.useCallback((smooth = true) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
  }, []);
  React.useEffect(() => {
    if (atBottom) scrollToEnd(false);
  }, [messages, atBottom, scrollToEnd]);

  const patch = React.useCallback((id: string, fn: (m: Msg) => Msg) => setMessages((all) => all.map((m) => (m.id === id ? fn(m) : m))), []);

  /** One reducer for stream events, shared by "send" and "retry". `target` is the assistant message being filled. */
  const applyEvent = React.useCallback(
    (targetRef: { id: string }, ev: StreamEvent) => {
      switch (ev.type) {
        case "turn": {
          const e = ev as unknown as { conversationId: string; userMessageId: string; assistantMessageId: string };
          setMessages((all) => all.map((m) => (m.id === targetRef.id ? { ...m, id: e.assistantMessageId } : m.id === `${targetRef.id}:user` ? { ...m, id: e.userMessageId } : m)));
          targetRef.id = e.assistantMessageId;
          setConversationId(e.conversationId);
          window.history.replaceState(null, "", `?c=${e.conversationId}`);
          break;
        }
        case "retrieval": {
          const e = ev as unknown as { hit: boolean; tainted: boolean; sources: SourceLite[] };
          patch(targetRef.id, (m) => ({ ...m, sources: e.sources, tainted: e.tainted, status: "streaming" }));
          break;
        }
        case "token": {
          const e = ev as unknown as { delta: string };
          if (e.delta) patch(targetRef.id, (m) => ({ ...m, content: m.content + e.delta, status: "streaming" }));
          break;
        }
        case "tool": {
          const e = ev as unknown as ToolItem;
          patch(targetRef.id, (m) => ({ ...m, tools: m.tools.some((t) => t.callId === e.callId) ? m.tools.map((t) => (t.callId === e.callId ? { ...t, ...e } : t)) : [...m.tools, e] }));
          break;
        }
        case "done": {
          const e = ev as unknown as { message: { content: string; citations: Citation[]; abstained: boolean } };
          patch(targetRef.id, (m) => ({ ...m, content: e.message.content, citations: e.message.citations, abstained: e.message.abstained, status: "complete", errorCode: null, retryable: false }));
          router.refresh(); // sidebar titles / ordering
          break;
        }
        case "error": {
          const e = ev as unknown as { code: string; retryable: boolean };
          patch(targetRef.id, (m) => ({ ...m, status: "failed", errorCode: e.code, retryable: e.retryable }));
          break;
        }
      }
    },
    [patch, router],
  );

  const send = React.useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy || !canWrite) return;
      const tmp = newRequestId();
      const targetRef = { id: tmp };
      setMessages((all) => [
        ...all,
        { id: `${tmp}:user`, role: "user", content: trimmed, status: "complete", citations: [], abstained: false, tools: [] },
        { id: tmp, role: "assistant", content: "", status: "pending", citations: [], abstained: false, tools: [] },
      ]);
      setInput("");
      setBusy(true);
      setAtBottom(true);
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        await streamPost(`/api/w/${workspace.id}/chat`, { message: trimmed, ...(conversationId ? { conversationId } : {}), clientRequestId: newRequestId() }, (ev) => applyEvent(targetRef, ev), ac.signal);
      } catch (err) {
        if (ac.signal.aborted) {
          patch(targetRef.id, (m) => ({ ...m, status: "failed", errorCode: "aborted", retryable: true }));
        } else if (err instanceof ApiError) {
          // Refused before anything was saved (rate limit / validation): roll back the optimistic rows and give the draft back.
          setMessages((all) => all.filter((m) => m.id !== targetRef.id && m.id !== `${tmp}:user`));
          setInput(trimmed);
          toast.error(err.message);
        } else {
          patch(targetRef.id, (m) => ({ ...m, status: "failed", errorCode: "timeout", retryable: false }));
          toast.error("Connection lost. Reload to see whether the answer finished.");
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [applyEvent, busy, canWrite, conversationId, patch, setInput, workspace.id],
  );

  const retry = React.useCallback(
    async (msg: Msg) => {
      if (busy) return;
      const targetRef = { id: msg.id };
      patch(msg.id, (m) => ({ ...m, content: "", status: "pending", errorCode: null, tools: [], citations: [], sources: undefined }));
      setBusy(true);
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        await streamPost(`/api/w/${workspace.id}/chat/retry`, { assistantMessageId: msg.id }, (ev) => applyEvent(targetRef, ev), ac.signal);
      } catch (err) {
        patch(msg.id, (m) => ({ ...m, status: "failed", errorCode: "timeout", retryable: true }));
        toast.error(err instanceof ApiError ? err.message : "Retry failed.");
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [applyEvent, busy, patch, workspace.id],
  );

  const decide = React.useCallback(
    async (msgId: string, callId: string, decision: "confirm" | "decline") => {
      try {
        const res = await api<{ status: string; errorCode: string | null }>(`/api/w/${workspace.id}/tools/${callId}`, { method: "POST", json: { decision } });
        patch(msgId, (m) => ({ ...m, tools: m.tools.map((t) => (t.callId === callId ? { ...t, status: res.status, message: res.errorCode ?? undefined } : t)) }));
        if (res.status === "succeeded") toast.success("Action approved and completed");
        else if (res.status === "declined") toast("Action declined");
        else toast.error("The action could not be completed.");
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : "Could not record your decision.");
      }
    },
    [patch, workspace.id],
  );

  const newChat = () => {
    setMessages([]);
    setConversationId(null);
    router.push(`/w/${workspace.id}`);
  };

  const citeFor = (msg: Msg) =>
    function cite(n: number) {
      return <CitationButton msg={msg} n={n} onOpen={setSource} />;
    };

  const empty = messages.length === 0;
  return (
    <div className="flex h-[calc(100dvh-3.75rem)] min-h-[28rem] md:h-[calc(100dvh-3.75rem)]">
      {/* conversation list (desktop) */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-panel/50 lg:flex" aria-label="Conversations">
        <div className="p-3">
          <Button variant="secondary" className="w-full justify-start" onClick={newChat}>
            <MessageSquarePlus /> New chat
          </Button>
        </div>
        <ConversationList items={conversations} activeId={conversationId} workspaceId={workspace.id} />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2 lg:hidden">
          <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
            <History /> History
          </Button>
          <Button variant="ghost" size="sm" onClick={newChat}>
            <MessageSquarePlus /> New
          </Button>
        </div>

        <div ref={scroller} className="pane-scroll relative flex-1 overflow-y-auto" onScroll={(e) => setAtBottom(e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 80)} role="log" aria-live="polite" aria-label="Conversation">
          {empty ? (
            <EmptyState icon={<FileText />} title={docTitles.length ? "Ask about this workspace's documents" : "Add a document to get started"} action={docTitles.length ? undefined : <Button variant="primary" onClick={() => router.push(`/w/${workspace.id}/documents`)}>Upload documents</Button>}>
              {docTitles.length ? (
                <>
                  Answers cite their sources, and the assistant says so when the documents don&apos;t contain the answer. Nothing from other workspaces is ever visible here.
                  <span className="mt-4 flex flex-wrap justify-center gap-2">
                    {docTitles.slice(0, 4).map((t) => (
                      <button key={t} type="button" className="rounded-full border border-line-strong bg-panel px-3 py-1.5 text-[13px] text-ink-2 hover:bg-panel-2 hover:text-ink" onClick={() => void send(`Summarise the key points of "${t}".`)}>
                        Summarise “{t.length > 28 ? `${t.slice(0, 28)}…` : t}”
                      </button>
                    ))}
                  </span>
                </>
              ) : (
                "Upload at least one document, then ask a question. You can also ask the assistant to save tasks or post summaries."
              )}
            </EmptyState>
          ) : (
            <ol className="mx-auto max-w-3xl space-y-7 px-4 py-6 sm:px-6">
              {messages.map((m) => (
                <li key={m.id} className={cn("rise-in", m.role === "user" ? "flex justify-end" : "")}>
                  {m.role === "user" ? (
                    <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-brand-soft px-4 py-2.5 text-ink">{m.content}</div>
                  ) : (
                    <AssistantMessage msg={m} cite={citeFor(m)} onRetry={() => void retry(m)} onInspect={() => setInspect({ messageId: m.id })} onDecide={(callId, d) => void decide(m.id, callId, d)} busy={busy} workspaceId={workspace.id} />
                  )}
                </li>
              ))}
            </ol>
          )}
          {!atBottom && !empty ? (
            <button onClick={() => scrollToEnd()} className="sticky bottom-3 left-1/2 z-10 mx-auto flex -translate-x-0 items-center gap-1.5 rounded-full border border-line-strong bg-panel px-3 py-1.5 text-xs text-ink shadow-2" aria-label="Jump to latest message">
              <ArrowDown className="size-3.5" /> Latest
            </button>
          ) : null}
        </div>

        <form
          className="border-t border-line bg-panel/70 p-3 backdrop-blur sm:p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <Textarea
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              rows={1}
              maxLength={4000}
              disabled={!canWrite}
              placeholder={canWrite ? `Ask ${workspace.name}…  (Enter to send, Shift+Enter for a new line)` : "Your role in this workspace is read-only."}
              aria-label="Message"
              className="max-h-[200px] flex-1"
            />
            {busy ? (
              <Button variant="secondary" size="icon" className="size-11" onClick={() => abortRef.current?.abort()} aria-label="Stop generating">
                <Square className="fill-current" />
              </Button>
            ) : (
              <Button type="submit" variant="primary" size="icon" className="size-11" disabled={!input.trim() || !canWrite} aria-label="Send message">
                <ArrowUp />
              </Button>
            )}
          </div>
          <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-ink-3">Answers come only from documents in “{workspace.name}”. Verify anything important against the cited source.</p>
        </form>
      </section>

      <Drawer open={historyOpen} onOpenChange={setHistoryOpen} title="Conversations">
        <ConversationList items={conversations} activeId={conversationId} workspaceId={workspace.id} onNavigate={() => setHistoryOpen(false)} />
      </Drawer>

      <Drawer open={!!source} onOpenChange={(o) => !o && setSource(null)} title={source?.msg.citations.find((c) => c.n === source.n)?.documentTitle ?? source?.msg.sources?.find((s) => s.n === source.n)?.documentTitle ?? "Source"} description={source ? `Source [${source.n}]` : undefined}>
        {source ? <SourceDetail msg={source.msg} n={source.n} onInspect={() => { const id = source.msg.id; setSource(null); setInspect({ messageId: id }); }} /> : null}
      </Drawer>

      <Drawer open={!!inspect} onOpenChange={(o) => !o && setInspect(null)} title="Retrieval inspector" description="Exactly which chunks were searched and shown to the model for this answer.">
        {inspect ? <InspectorLoader workspace={workspace} messageId={inspect.messageId} /> : null}
      </Drawer>
    </div>
  );
}

/* ───────────── pieces ───────────── */

function ConversationList({ items, activeId, workspaceId, onNavigate }: { items: { id: string; title: string; updatedAt: string }[]; activeId: string | null; workspaceId: string; onNavigate?: () => void }) {
  const router = useRouter();
  if (items.length === 0) return <p className="px-4 py-6 text-sm text-ink-2">No conversations yet.</p>;
  return (
    <ul className="pane-scroll flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
      {items.map((c) => (
        <li key={c.id}>
          <button
            onClick={() => {
              onNavigate?.();
              router.push(`/w/${workspaceId}?c=${c.id}`);
            }}
            aria-current={c.id === activeId ? "true" : undefined}
            className={cn("w-full truncate rounded-md px-3 py-2 text-left text-sm", c.id === activeId ? "bg-brand-soft font-medium text-brand" : "text-ink-2 hover:bg-panel-2 hover:text-ink")}
          >
            {c.title}
          </button>
        </li>
      ))}
    </ul>
  );
}

const TOOL_LABEL: Record<string, string> = { save_task: "Save task", list_tasks: "List tasks", send_summary: "Send summary", search_documents: "Search documents" };

function ToolCard({ tool, onDecide }: { tool: ToolItem; onDecide: (callId: string, d: "confirm" | "decline") => void }) {
  const [pending, setPending] = React.useState<"confirm" | "decline" | null>(null);
  const label = TOOL_LABEL[tool.name] ?? tool.name;
  const map: Record<string, { tone: "good" | "warn" | "bad" | "neutral" | "brand"; text: string; icon: React.ReactNode }> = {
    succeeded: { tone: "good", text: "Done", icon: <CheckCircle2 className="size-3.5" /> },
    running: { tone: "brand", text: "Running", icon: <Loader2 className="size-3.5 animate-spin" /> },
    awaiting_confirmation: { tone: "warn", text: "Needs your approval", icon: <ShieldAlert className="size-3.5" /> },
    rejected: { tone: "bad", text: tool.message === "unknown_tool" ? "Blocked: no such tool" : "Blocked: invalid request", icon: <Ban className="size-3.5" /> },
    failed: { tone: "bad", text: "Failed", icon: <X className="size-3.5" /> },
    declined: { tone: "neutral", text: "Declined", icon: <X className="size-3.5" /> },
  };
  const s = map[tool.status] ?? { tone: "neutral" as const, text: tool.status, icon: null };
  return (
    <div className={cn("rounded-lg border p-3 text-sm", tool.status === "awaiting_confirmation" ? "border-warn/40 bg-warn-soft" : "border-line bg-panel-2")}>
      <div className="flex flex-wrap items-center gap-2">
        <Wrench className="size-4 text-ink-2" aria-hidden />
        <span className="font-medium text-ink">{label}</span>
        <Badge tone={s.tone}>
          {s.icon} {s.text}
        </Badge>
        {tool.message && tool.status === "failed" ? <span className="text-xs text-ink-3">{tool.message.replaceAll("_", " ")}</span> : null}
      </div>
      {tool.status === "awaiting_confirmation" ? (
        <div className="mt-2.5 space-y-2.5">
          <p className="text-[13px] text-ink-2">A retrieved document contained instructions aimed at the assistant, so this action was <b className="text-ink">not</b> run. Only approve it if <i>you</i> want it done.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" loading={pending === "confirm"} disabled={pending !== null} onClick={() => { setPending("confirm"); onDecide(tool.callId, "confirm"); }}>
              <Check /> Approve
            </Button>
            <Button size="sm" variant="secondary" loading={pending === "decline"} disabled={pending !== null} onClick={() => { setPending("decline"); onDecide(tool.callId, "decline"); }}>
              Decline
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AssistantMessage({ msg, cite, onRetry, onInspect, onDecide, busy, workspaceId }: { msg: Msg; cite: (n: number) => React.ReactNode; onRetry: () => void; onInspect: () => void; onDecide: (callId: string, d: "confirm" | "decline") => void; busy: boolean; workspaceId: string }) {
  const [copied, setCopied] = React.useState(false);
  const streaming = msg.status === "pending" || msg.status === "streaming";
  const failed = msg.status === "failed";
  return (
    <article className="max-w-none" aria-busy={streaming}>
      {msg.tainted ? (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-[13px] text-ink">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <span>A retrieved document contains suspicious instructions. It is treated as data, and any action it tries to trigger will wait for your approval.</span>
        </div>
      ) : null}

      {msg.tools.length ? (
        <div className="mb-3 space-y-2">
          {[...msg.tools].sort((a, b) => a.step - b.step).map((t) => (
            <ToolCard key={t.callId} tool={t} onDecide={onDecide} />
          ))}
        </div>
      ) : null}

      {streaming && !msg.content ? (
        <p className="flex items-center gap-2 text-sm text-ink-2">
          <Spinner /> {msg.sources ? (msg.sources.length ? `Reading ${msg.sources.length} source${msg.sources.length === 1 ? "" : "s"}…` : "Nothing relevant found…") : "Searching this workspace…"}
        </p>
      ) : null}

      {msg.content ? (
        <div className={cn("text-[15px] leading-relaxed text-ink", msg.abstained && "rounded-lg border border-line bg-panel-2 px-4 py-3 text-ink-2")}>
          {msg.abstained ? (
            <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
              <Ban className="size-3.5" aria-hidden /> Not in this workspace&apos;s documents
            </p>
          ) : null}
          <Markdown text={msg.content} cite={cite} />
          {streaming ? <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-[pulse-dot_1s_ease_infinite] rounded-sm bg-brand" aria-hidden /> : null}
        </div>
      ) : null}

      {failed ? (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-bad/30 bg-bad-soft px-3 py-2.5 text-sm">
          <AlertTriangle className="size-4 shrink-0 text-bad" aria-hidden />
          <span className="flex-1 text-ink">{ERRORS[msg.errorCode ?? ""] ?? "Something went wrong."} Your question was saved.</span>
          <Button size="sm" variant="secondary" onClick={onRetry} disabled={busy}>
            <RotateCcw /> Retry
          </Button>
        </div>
      ) : null}

      {msg.status === "complete" && msg.citations.length ? (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Sources">
          {msg.citations.map((c) => (
            <li key={c.n}>
              <SourceChip citation={c} />
            </li>
          ))}
        </ul>
      ) : null}

      {msg.status === "complete" || failed ? (
        <div className="mt-2.5 flex items-center gap-1 text-ink-3">
          {msg.content ? (
            <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(msg.content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })} aria-label="Copy answer">
              {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
            </Button>
          ) : null}
          {msg.status === "complete" && !msg.id.includes(":") ? (
            <Button variant="ghost" size="sm" onClick={onInspect}>
              <ScanSearch /> Inspect retrieval
            </Button>
          ) : null}
          <span className="sr-only">workspace {workspaceId}</span>
        </div>
      ) : null}
    </article>
  );
}

function SourceChip({ citation }: { citation: Citation }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-xs text-ink-2" title={citation.snippet}>
      <span className="grid size-4 place-items-center rounded bg-brand-soft font-mono text-[10px] font-semibold text-brand">{citation.n}</span>
      <FileText className="size-3 shrink-0" aria-hidden />
      <span className="truncate font-medium text-ink">{citation.documentTitle}</span>
      {sectionLabel(citation.documentTitle, citation.headingPath) ? <span className="hidden truncate text-ink-3 sm:inline">· {sectionLabel(citation.documentTitle, citation.headingPath)}</span> : null}
    </span>
  );
}

function SourceDetail({ msg, n, onInspect }: { msg: Msg; n: number; onInspect: () => void }) {
  const c = msg.citations.find((x) => x.n === n);
  const s = msg.sources?.find((x) => x.n === n);
  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-1">
        <p className="font-medium text-ink">{c?.documentTitle ?? s?.documentTitle}</p>
        {sectionLabel((c?.documentTitle ?? s?.documentTitle) ?? "", (c?.headingPath ?? s?.headingPath) ?? "") ? <p className="text-ink-2">{sectionLabel((c?.documentTitle ?? s?.documentTitle) ?? "", (c?.headingPath ?? s?.headingPath) ?? "")}</p> : null}
        {s?.flagged ? <Badge tone="warn"><AlertTriangle className="size-3" aria-hidden /> Flagged: suspicious instructions in this passage</Badge> : null}
      </div>
      {c ? <blockquote className="rounded-md border-l-2 border-brand bg-panel-2 p-3 text-ink-2">{c.snippet}…</blockquote> : <p className="text-ink-2">The answer is still being written.</p>}
      {c ? <p className="font-mono text-[11px] text-ink-3">chunk {c.chunkId}</p> : null}
      {msg.status === "complete" && !msg.id.includes(":") ? <Button variant="soft" size="sm" onClick={onInspect}><ScanSearch /> Inspect the full retrieval</Button> : null}
    </div>
  );
}

function InspectorLoader({ workspace, messageId }: { workspace: { id: string; name: string; color: string }; messageId: string }) {
  const [state, setState] = React.useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "ok"; event: RetrievalEventDTO }>({ kind: "loading" });
  React.useEffect(() => {
    let live = true;
    api<{ event: RetrievalEventDTO }>(`/api/w/${workspace.id}/inspector?messageId=${messageId}`)
      .then((r) => live && setState({ kind: "ok", event: r.event }))
      .catch((e: unknown) => live && setState({ kind: "error", message: e instanceof ApiError ? e.message : "Could not load the retrieval record." }));
    return () => {
      live = false;
    };
  }, [workspace.id, messageId]);
  if (state.kind === "loading") return <div className="flex items-center gap-2 text-sm text-ink-2"><Spinner /> Loading…</div>;
  if (state.kind === "error") return <p role="alert" className="text-sm text-bad">{state.message}</p>;
  return <RetrievalPanel event={state.event} workspaceName={workspace.name} workspaceColor={workspace.color} />;
}

function CitationButton({ msg, n, onOpen }: { msg: Msg; n: number; onOpen: (s: { msg: Msg; n: number }) => void }) {
  const c = msg.citations.find((x) => x.n === n);
  const known = !!c || !!msg.sources?.some((x) => x.n === n);
  return (
    <button
      type="button"
      onClick={() => known && onOpen({ msg, n })}
      disabled={!known}
      className="mx-0.5 inline-flex h-[18px] min-w-[18px] -translate-y-px items-center justify-center rounded bg-brand-soft px-1 align-baseline font-mono text-[11px] font-medium text-brand hover:brightness-110 disabled:opacity-60"
      aria-label={`Source ${n}${c ? `: ${c.documentTitle}` : ""}`}
    >
      {n}
    </button>
  );
}
