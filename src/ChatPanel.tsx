import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { asCodexError, drainCodexEvents, interruptTurn, loadThread, openThread, respondToCodexRequest, sendMessage } from "./api";
import { applyCodexEvent, createChatSession, eventRequest } from "./lib/chat";
import { MarkdownContent } from "./MarkdownContent";
import type { BoardThread, ChatSession, JsonValue, PendingCodexRequest } from "./types";

type JsonObject = Record<string, JsonValue>;
const record = (value: JsonValue | undefined): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const text = (value: JsonValue | undefined): string => typeof value === "string" ? value : "";
const sameRequest = (left: JsonValue, right: JsonValue) => JSON.stringify(left) === JSON.stringify(right);

function ApprovalPrompt({ request, busy, onResolve }: { request: PendingCodexRequest; busy: boolean; onResolve: (result: JsonValue) => void }) {
  const { method, params } = request;
  const questions = Array.isArray(params.questions) ? params.questions.map(record) : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const command = text(params.command);
  const reason = text(params.reason);
  const cwd = text(params.cwd);

  if (method === "item/tool/requestUserInput") {
    return (
      <section className="approval-card" role="dialog" aria-label="Codex needs your input">
        <div className="approval-heading"><span>?</span><div><strong>Codex needs your input</strong><small>The turn will continue after your answer.</small></div></div>
        {questions.map((question) => {
          const id = text(question.id);
          const options = Array.isArray(question.options) ? question.options.map(record) : [];
          return (
            <fieldset key={id}>
              <legend>{text(question.header) || "Question"}</legend>
              <p>{text(question.question)}</p>
              {options.length > 0 ? options.map((option) => {
                const label = text(option.label);
                return <label className="approval-option" key={label}><input type="radio" name={id} checked={answers[id] === label} onChange={() => setAnswers((current) => ({ ...current, [id]: label }))} /><span><strong>{label}</strong><small>{text(option.description)}</small></span></label>;
              }) : <input className="approval-input" value={answers[id] || ""} onChange={(event) => setAnswers((current) => ({ ...current, [id]: event.target.value }))} />}
            </fieldset>
          );
        })}
        <div className="approval-actions">
          <button className="secondary" disabled={busy} onClick={() => onResolve({ answers: Object.fromEntries(questions.map((question) => [text(question.id), { answers: [] }])) })}>Skip</button>
          <button disabled={busy || questions.some((question) => !answers[text(question.id)]?.trim())} onClick={() => onResolve({ answers: Object.fromEntries(questions.map((question) => [text(question.id), { answers: [answers[text(question.id)]] }])) })}>Continue</button>
        </div>
      </section>
    );
  }

  if (method === "item/permissions/requestApproval") {
    return <section className="approval-card" role="dialog" aria-label="Permission request"><div className="approval-heading"><span>!</span><div><strong>Additional permissions</strong><small>{reason || "Codex requested additional local permissions."}</small></div></div><pre>{JSON.stringify(params.permissions, null, 2)}</pre><div className="approval-actions"><button className="secondary" disabled={busy} onClick={() => onResolve({ permissions: {}, scope: "turn" })}>Deny</button><button disabled={busy} onClick={() => onResolve({ permissions: params.permissions || {}, scope: "turn" })}>Allow once</button><button disabled={busy} onClick={() => onResolve({ permissions: params.permissions || {}, scope: "session" })}>Allow session</button></div></section>;
  }

  if (method === "mcpServer/elicitation/request") {
    return <section className="approval-card" role="dialog" aria-label="MCP request"><div className="approval-heading"><span>!</span><div><strong>{text(params.serverName) || "MCP server"} needs input</strong><small>{text(params.message) || "This request is not supported by the compact client yet."}</small></div></div><div className="approval-actions"><button className="secondary" disabled={busy} onClick={() => onResolve({ action: "decline", content: null })}>Decline</button></div></section>;
  }

  const isFile = method === "item/fileChange/requestApproval";
  const isCommand = method === "item/commandExecution/requestApproval";
  return (
    <section className="approval-card" role="dialog" aria-label="Approval request">
      <div className="approval-heading"><span>!</span><div><strong>{isFile ? "Approve file changes?" : isCommand ? "Run this command?" : "Codex requests approval"}</strong><small>{reason || (isFile ? "Codex wants to modify files." : "Review this action before continuing.")}</small></div></div>
      {command && <pre>{command}</pre>}{cwd && <div className="approval-path">in {cwd}</div>}
      <div className="approval-actions"><button className="secondary" disabled={busy} onClick={() => onResolve({ decision: "decline" })}>Deny</button>{(isFile || isCommand) && <button disabled={busy} onClick={() => onResolve({ decision: "accept" })}>Allow once</button>}{(isFile || isCommand) && <button disabled={busy} onClick={() => onResolve({ decision: "acceptForSession" })}>Allow session</button>}</div>
    </section>
  );
}

export function ChatPanel({ thread, onClose }: { thread: BoardThread; onClose: () => void }) {
  const [session, setSession] = useState<ChatSession | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [requests, setRequests] = useState<PendingCodexRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const request = requests[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setSession(null); setRequests([]); setError(null);
    void loadThread(thread.id).then((loaded) => { if (!cancelled) setSession(createChatSession(loaded)); }).catch((cause) => { if (!cancelled) setError(asCodexError(cause).message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [thread.id]);

  useEffect(() => {
    if (loading || !session) return;
    let stopped = false;
    let polling = false;
    const poll = async () => {
      if (polling || stopped) return;
      polling = true;
      try {
        const events = await drainCodexEvents();
        if (stopped) return;
        setSession((current) => current ? events.reduce((value, event) => applyCodexEvent(value, event, thread.id), current) : current);
        for (const event of events) {
          const pending = eventRequest(event, thread.id);
          if (pending) setRequests((current) => current.some((item) => sameRequest(item.requestId, pending.requestId)) ? current : [...current, pending]);
          if (event.method === "serverRequest/resolved") {
            const resolvedId = record(event.params).requestId;
            setRequests((current) => current.filter((item) => !sameRequest(item.requestId, resolvedId)));
          }
        }
      } catch (cause) { if (!stopped) setError(asCodexError(cause).message); }
      finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 120);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [loading, session === null, thread.id]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [session?.items, request]);

  const title = useMemo(() => thread.displayTitle || thread.effectiveTitle || "Untitled thread", [thread]);

  async function submit() {
    const message = draft.trim();
    if (!message || sending || session?.running) return;
    setSending(true); setError(null);
    try {
      const response = record(await sendMessage(thread.id, message));
      const turn = record(response.turn);
      setDraft("");
      setSession((current) => current ? { ...current, running: true, activeTurnId: text(turn.id) || current.activeTurnId } : current);
    } catch (cause) { setError(asCodexError(cause).message); }
    finally { setSending(false); }
  }

  async function stop() {
    if (!session?.activeTurnId) return;
    try { await interruptTurn(thread.id, session.activeTurnId); }
    catch (cause) { setError(asCodexError(cause).message); }
  }

  async function resolveRequest(result: JsonValue) {
    if (!request) return;
    setApprovalBusy(true);
    try {
      await respondToCodexRequest(request.requestId, result);
      setRequests((current) => current.filter((item) => !sameRequest(item.requestId, request.requestId)));
    } catch (cause) { setError(asCodexError(cause).message); }
    finally { setApprovalBusy(false); }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
  }

  return (
    <div className="chat-overlay"><section className="chat-panel" aria-label={`Chat: ${title}`}>
      <header className="chat-header"><button className="icon-button" onClick={onClose} aria-label="Back to board">←</button><div className="chat-heading"><h2>{title}</h2><p>{thread.cwd || "Local Codex thread"}</p></div><button className="external-button" onClick={() => void openThread(thread.id)}>Open in Codex ↗</button></header>
      <div className="chat-body">
        {loading && <div className="chat-loading"><div className="spinner" /><span>Loading conversation…</span></div>}
        {!loading && error && <div className="chat-error" role="alert">{error}<button onClick={() => setError(null)}>×</button></div>}
        {!loading && session?.items.length === 0 && <div className="chat-empty"><h3>Continue this thread</h3><p>Send a message below. Codex will work in the thread's existing project.</p></div>}
        {session?.items.map((item) => item.kind === "activity" ? (
          <details key={item.id} className="chat-item activity">
            <summary><span>{item.title || "Activity"}</span>{item.status && <small>{item.status}</small>}</summary>
            <div className="chat-item-text">{item.text || "Working…"}</div>
          </details>
        ) : (
          <article key={item.id} className={`chat-item ${item.kind}`}>
            {item.title && <div className="chat-item-title"><span>{item.title}</span>{item.status && <small>{item.status}</small>}</div>}
            <div className="chat-item-text"><MarkdownContent>{item.text || (item.kind === "assistant" ? "Thinking…" : "Working…")}</MarkdownContent></div>
          </article>
        ))}
        {session?.running && <div className="working-indicator"><span /><span /><span /><em>Codex is working</em></div>}
        {request && <ApprovalPrompt request={request} busy={approvalBusy} onResolve={(result) => void resolveRequest(result)} />}
        <div ref={bottomRef} />
      </div>
      <footer className="composer-wrap"><div className="composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder={session?.running ? "Codex is working…" : "Message Codex…"} disabled={loading || session?.running} rows={2} />{session?.running ? <button className="stop-button" disabled={!session.activeTurnId} onClick={() => void stop()}>Stop</button> : <button className="send-button" disabled={!draft.trim() || sending || loading} onClick={() => void submit()}>{sending ? "Sending…" : "Send"}</button>}</div><small>Enter to send · Shift+Enter for a new line</small></footer>
    </section></div>
  );
}
