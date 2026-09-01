import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { asCodexError, interruptTurn, loadThread, respondToCodexRequest } from "./api";
import { applyCodexEvent, createChatSession, eventRequest } from "./lib/chat";
import { denialResult } from "./lib/approvals";
import { MarkdownContent } from "./MarkdownContent";
import { Icon } from "./ui/Icon";
import type { BoardThread, ChatSession, JsonValue, PendingCodexRequest, QueuedMessage, SequencedCodexEvent } from "./types";

type JsonObject = Record<string, JsonValue>;
const record = (value: JsonValue | undefined): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const text = (value: JsonValue | undefined): string => typeof value === "string" ? value : "";
const sameRequest = (left: JsonValue, right: JsonValue) => JSON.stringify(left) === JSON.stringify(right);

interface ChatPanelProps {
  thread: BoardThread;
  events: SequencedCodexEvent[];
  queuedMessages: QueuedMessage[];
  working: boolean;
  activeTurnId: string | null;
  onSend: (threadId: string, message: string) => Promise<void>;
  onRemoveQueued: (threadId: string, messageId: string) => void;
  onSessionState: (threadId: string, running: boolean, turnId: string | null) => void;
  onClose: () => void;
}

function ApprovalPrompt({ request, busy, onResolve }: { request: PendingCodexRequest; busy: boolean; onResolve: (result: JsonValue) => void }) {
  const { method, params } = request;
  const questions = Array.isArray(params.questions) ? params.questions.map(record) : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const command = text(params.command);
  const reason = text(params.reason);
  const cwd = text(params.cwd);

  if (method === "item/tool/requestUserInput") {
    return <section className="approval-card" role="dialog" aria-label="Codex needs your input">
      <div className="approval-heading"><span>?</span><div><strong>Codex needs your input</strong><small>The turn will continue after your answer.</small></div></div>
      {questions.map((question) => {
        const id = text(question.id);
        const options = Array.isArray(question.options) ? question.options.map(record) : [];
        return <fieldset key={id}><legend>{text(question.header) || "Question"}</legend><p>{text(question.question)}</p>
          {options.length > 0 ? options.map((option) => {
            const label = text(option.label);
            return <label className="approval-option" key={label}><input type="radio" name={id} checked={answers[id] === label} onChange={() => setAnswers((current) => ({ ...current, [id]: label }))} /><span><strong>{label}</strong><small>{text(option.description)}</small></span></label>;
          }) : <input className="approval-input" value={answers[id] || ""} onChange={(event) => setAnswers((current) => ({ ...current, [id]: event.target.value }))} />}
        </fieldset>;
      })}
      <div className="approval-actions"><button className="secondary" disabled={busy} onClick={() => onResolve({ answers: Object.fromEntries(questions.map((question) => [text(question.id), { answers: [] }])) })}>Skip</button><button disabled={busy || questions.some((question) => !answers[text(question.id)]?.trim())} onClick={() => onResolve({ answers: Object.fromEntries(questions.map((question) => [text(question.id), { answers: [answers[text(question.id)]] }])) })}>Continue</button></div>
    </section>;
  }

  if (method === "item/permissions/requestApproval") {
    return <section className="approval-card" role="dialog" aria-label="Permission request"><div className="approval-heading"><span>!</span><div><strong>Additional permissions</strong><small>{reason || "Codex requested additional local permissions."}</small></div></div><pre>{JSON.stringify(params.permissions, null, 2)}</pre><div className="approval-actions"><button className="secondary" disabled={busy} onClick={() => onResolve({ permissions: {}, scope: "turn" })}>Deny</button><button disabled={busy} onClick={() => onResolve({ permissions: params.permissions || {}, scope: "turn" })}>Allow once</button><button disabled={busy} onClick={() => onResolve({ permissions: params.permissions || {}, scope: "session" })}>Allow session</button></div></section>;
  }

  if (method === "mcpServer/elicitation/request") {
    return <section className="approval-card" role="dialog" aria-label="MCP request"><div className="approval-heading"><span>!</span><div><strong>{text(params.serverName) || "MCP server"} needs input</strong><small>{text(params.message) || "This MCP request needs to be handled in Codex."}</small></div></div><div className="approval-actions"><button className="secondary" disabled={busy} onClick={() => onResolve({ action: "decline", content: null })}>Decline</button></div></section>;
  }

  const deny = denialResult(request);
  const isFile = method === "item/fileChange/requestApproval";
  const isCommand = method === "item/commandExecution/requestApproval";
  return <section className="approval-card" role="dialog" aria-label="Approval request">
    <div className="approval-heading"><span>!</span><div><strong>{isFile ? "Approve file changes?" : isCommand ? "Run this command?" : "Codex requests approval"}</strong><small>{reason || (isFile ? "Codex wants to modify files." : "Review this action before continuing.")}</small></div></div>
    {command && <pre>{command}</pre>}{cwd && <div className="approval-path">in {cwd}</div>}
    <div className="approval-actions">{deny && <button className="secondary" disabled={busy} onClick={() => onResolve(deny)}>Deny</button>}<button disabled={busy} onClick={() => onResolve({ decision: "accept" })}>Allow once</button><button disabled={busy} onClick={() => onResolve({ decision: "acceptForSession" })}>Allow session</button></div>
  </section>;
}

function ChatComposer({ threadId, working, activeTurnId, loading, onSend, onStop, onError }: {
  threadId: string;
  working: boolean;
  activeTurnId: string | null;
  loading: boolean;
  onSend: (threadId: string, message: string) => Promise<void>;
  onStop: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  async function submit() {
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true); onError(null);
    try { await onSend(threadId, message); setDraft(""); }
    catch (cause) { onError(asCodexError(cause).message); }
    finally { setSending(false); }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
  }

  return <footer className="composer-wrap"><div className="composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKeyDown} placeholder={working ? "Add another message to the queue…" : "Message Codex…"} disabled={loading} rows={2} />{working ? <><button className="stop-button" disabled={!activeTurnId} onClick={() => void onStop()}>Stop</button><button className="send-button" disabled={!draft.trim() || sending || loading} onClick={() => void submit()}>{sending ? "Adding…" : "Queue"}</button></> : <button className="send-button" disabled={!draft.trim() || sending || loading} onClick={() => void submit()}>{sending ? "Sending…" : "Send"}</button>}</div><small>Enter to send · Shift+Enter for a new line</small></footer>;
}

export function ChatPanel({ thread, events, queuedMessages, working, activeTurnId, onSend, onRemoveQueued, onSessionState, onClose }: ChatPanelProps) {
  const [session, setSession] = useState<ChatSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [requests, setRequests] = useState<PendingCodexRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastSequence = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const request = requests[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    lastSequence.current = events.at(-1)?.sequence || 0;
    setLoading(true); setSession(null); setRequests([]); setError(null);
    void loadThread(thread.id).then((loaded) => {
      if (cancelled) return;
      const next = createChatSession(loaded);
      setSession(next);
      onSessionState(thread.id, next.running, next.activeTurnId);
    }).catch((cause) => { if (!cancelled) setError(asCodexError(cause).message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [thread.id]);

  useEffect(() => {
    if (!session) return;
    const fresh = events.filter((entry) => entry.sequence > lastSequence.current);
    if (fresh.length === 0) return;
    lastSequence.current = fresh.at(-1)!.sequence;
    setSession((current) => current ? fresh.reduce((value, entry) => applyCodexEvent(value, entry.event, thread.id), current) : current);
    for (const { event } of fresh) {
      const pending = eventRequest(event, thread.id);
      if (pending) setRequests((current) => current.some((item) => sameRequest(item.requestId, pending.requestId)) ? current : [...current, pending]);
      if (event.method === "serverRequest/resolved") {
        const resolvedId = record(event.params).requestId;
        setRequests((current) => current.filter((item) => !sameRequest(item.requestId, resolvedId)));
      }
    }
  }, [events, session === null, thread.id]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [session?.items, queuedMessages, request]);
  const title = useMemo(() => thread.displayTitle || thread.effectiveTitle || "Untitled thread", [thread]);

  async function stop() {
    if (!activeTurnId) return;
    try { await interruptTurn(thread.id, activeTurnId); }
    catch (cause) { setError(asCodexError(cause).message); }
  }

  async function resolveRequest(result: JsonValue) {
    if (!request) return;
    setApprovalBusy(true);
    try { await respondToCodexRequest(request.requestId, result); setRequests((current) => current.filter((item) => !sameRequest(item.requestId, request.requestId))); }
    catch (cause) { setError(asCodexError(cause).message); }
    finally { setApprovalBusy(false); }
  }

  return <div className="chat-overlay"><section className="chat-panel" aria-label={`Chat: ${title}`}>
    <header className="chat-header"><button className="icon-button chat-back-button" onClick={onClose} aria-label="Back to board"><Icon name="chevronLeft" /></button><div className="chat-heading"><div className="chat-title-row"><h2>{title}</h2><span className={working ? "chat-state live" : "chat-state"}><i />{working ? "Working" : "Ready"}</span></div><p>{thread.cwd || "Local Codex thread"}</p></div></header>
    <div className="chat-body">
      {loading && <div className="chat-loading"><div className="spinner" /><span>Loading conversation…</span></div>}
      {!loading && error && <div className="chat-error" role="alert">{error}<button onClick={() => setError(null)}>×</button></div>}
      {!loading && session?.items.length === 0 && <div className="chat-empty"><h3>Continue this thread</h3><p>Send a message below. Codex will work in the thread&apos;s existing project.</p></div>}
      {session?.items.map((item) => item.kind === "activity" ? <details key={item.id} className="chat-item activity"><summary><span>{item.title || "Activity"}</span>{item.status && <small>{item.status}</small>}</summary><div className="chat-item-text">{item.text || "Working…"}</div></details> : <article key={item.id} className={`chat-item ${item.kind}`}>{item.title && <div className="chat-item-title"><span>{item.title}</span>{item.status && <small>{item.status}</small>}</div>}<div className="chat-item-text"><MarkdownContent>{item.text || (item.kind === "assistant" ? "Thinking…" : "Working…")}</MarkdownContent></div></article>)}
      {working && <div className="working-indicator"><span /><span /><span /><em>Codex is working</em></div>}
      {queuedMessages.length > 0 && <section className="message-queue"><div className="queue-heading"><strong>Message queue</strong><span>{queuedMessages.length} waiting</span></div>{queuedMessages.map((message, index) => <div className="queued-message" key={message.id}><span>{index + 1}</span><p>{message.text}</p><button aria-label="Remove queued message" onClick={() => onRemoveQueued(thread.id, message.id)}>×</button></div>)}</section>}
      {request && <ApprovalPrompt request={request} busy={approvalBusy} onResolve={(result) => void resolveRequest(result)} />}
      <div ref={bottomRef} />
    </div>
    <ChatComposer key={thread.id} threadId={thread.id} working={working} activeTurnId={activeTurnId} loading={loading} onSend={onSend} onStop={stop} onError={setError} />
  </section></div>;
}
