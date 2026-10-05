import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";
import { asCodexError, compactThread, getModels, interruptTurn, loadThread, respondToCodexRequest } from "./api";
import { applyCodexEvent, createChatSession, eventRequest } from "./lib/chat";
import { denialResult } from "./lib/approvals";
import { MarkdownContent } from "./MarkdownContent";
import { Icon } from "./ui/Icon";
import type { BoardThread, ChatSession, JsonValue, PendingCodexRequest, QueuedMessage, SequencedCodexEvent, TurnSettings } from "./types";

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
  onSend: (threadId: string, message: string, imageUrls?: string[], settings?: TurnSettings) => Promise<void>;
  onRemoveQueued: (threadId: string, messageId: string) => void;
  onSessionState: (threadId: string, running: boolean, turnId: string | null) => void;
  onFork: (threadId: string) => void;
  onRename: (threadId: string) => void;
  onClose: () => void;
}

interface ImageAttachmentDraft { id: string; name: string; dataUrl: string; }

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

function ChatComposer({ threadId, working, activeTurnId, loading, onSend, onStop, onError, controls, attachments, onRemoveAttachment, onClearAttachments }: {
  threadId: string;
  working: boolean;
  activeTurnId: string | null;
  loading: boolean;
  onSend: (threadId: string, message: string, imageUrls?: string[], settings?: TurnSettings) => Promise<void>;
  onStop: () => Promise<void>;
  onError: (message: string | null) => void;
  controls: ReactNode;
  attachments: ImageAttachmentDraft[];
  onRemoveAttachment: (id: string) => void;
  onClearAttachments: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  async function submit() {
    const message = draft.trim();
    if ((!message && attachments.length === 0) || sending) return;
    if (!localStorage.getItem("codex-board.model")) { onError("Choose a Codex model before sending."); return; }
    setSending(true); onError(null);
    try { await onSend(threadId, message, attachments.map((attachment) => attachment.dataUrl)); setDraft(""); onClearAttachments(); }
    catch (cause) { onError(asCodexError(cause).message); }
    finally { setSending(false); }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
  }

  return <footer className="composer-wrap"><div className="composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKeyDown} placeholder={working ? "Add another message to the queue…" : "Message Codex…"} disabled={loading} rows={2} />{attachments.length > 0 && <div className="composer-attachments">{attachments.map((attachment) => <div className="composer-attachment" key={attachment.id}><img src={attachment.dataUrl} alt="" /><span title={attachment.name}>{attachment.name}</span><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => onRemoveAttachment(attachment.id)}>×</button></div>)}</div>}<div className="composer-bottom"><div className="composer-tools">{controls}</div><div className="composer-actions">{working && <button className="stop-button" disabled={!activeTurnId} onClick={() => void onStop()}>Stop</button>}<button className="send-button" disabled={(!draft.trim() && attachments.length === 0) || sending || loading} onClick={() => void submit()}>{working ? (sending ? "Adding…" : "Queue") : (sending ? "Sending…" : "Send")}</button></div></div></div><small>Enter to send · Shift+Enter for a new line</small></footer>;
}

function ImageAttachmentButton({ onSelect, onError, disabled, open, onOpenChange, selectedCount }: { onSelect: (attachments: ImageAttachmentDraft[]) => void; onError: (message: string | null) => void; disabled: boolean; open: boolean; onOpenChange: (open: boolean) => void; selectedCount: number }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  function readFile(file: File): Promise<ImageAttachmentDraft> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string" ? resolve({ id: crypto.randomUUID(), name: file.name, dataUrl: reader.result }) : reject(new Error(`Could not read ${file.name}`));
      reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
      reader.readAsDataURL(file);
    });
  }
  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    setBusy(true); onError(null);
    void Promise.all(files.map(readFile)).then(onSelect).catch((cause) => onError(asCodexError(cause).message)).finally(() => setBusy(false));
  }
  return <div className="attachment-picker"><input ref={inputRef} hidden type="file" accept="image/*" multiple onChange={handleFiles} /><button type="button" className="composer-tool-button attachment-trigger" disabled={disabled || busy} onClick={() => onOpenChange(!open)} aria-label="Attachments"><Icon name="paperclip" /><span>{busy ? "Reading…" : selectedCount ? `Attach · ${selectedCount}` : "Attach"}</span></button>{open && <div className="attachment-popover"><strong>Attach images</strong><button type="button" onClick={() => { onOpenChange(false); inputRef.current?.click(); }}><Icon name="paperclip" /><span>Choose images</span></button><small>Select one or more images; they’ll send with your next message.</small></div>}</div>;
}

function TurnSettingsBar({ threadId, working, open, onOpenChange }: { threadId: string; working: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [model, setModel] = useState(() => localStorage.getItem("codex-board.model") || "");
  const [effort, setEffort] = useState(() => localStorage.getItem("codex-board.effort") || "");
  const [summary, setSummary] = useState(() => localStorage.getItem("codex-board.summary") || "auto");
  const [tier, setTier] = useState(() => localStorage.getItem("codex-board.serviceTier") || "");
  const [models, setModels] = useState<Array<{ id: string; name: string; efforts: string[]; tiers: string[] }>>([]);
  const [compacting, setCompacting] = useState(false);
  useEffect(() => {
    let alive = true;
    void getModels().then((value) => {
      const data = record(value).data;
      if (!alive || !Array.isArray(data)) return;
      const next = data.map((item) => {
        const row = record(item);
        return { id: text(row.model) || text(row.id), name: text(row.displayName) || text(row.model) || text(row.id), efforts: Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts.map((entry) => text(record(entry).reasoningEffort)).filter(Boolean) : [], tiers: Array.isArray(row.serviceTiers) ? row.serviceTiers.map((entry) => text(record(entry).id)).filter(Boolean) : [] };
      }).filter((item) => item.id);
      setModels(next);
      if (next.length && !next.some((item) => item.id === model)) { setModel(""); localStorage.removeItem("codex-board.model"); }
    }).catch(() => { /* keep Default when Codex catalog is unavailable */ });
    return () => { alive = false; };
  }, []);
  const selected = models.find((item) => item.id === model);
  const efforts = selected?.efforts.length ? selected.efforts : ["low", "medium", "high", "xhigh"];
  const tiers = selected?.tiers.length ? selected.tiers : ["priority"];
  function save(key: string, value: string, setter: (value: string) => void) { setter(value); localStorage.setItem(key, value); }
  async function compact() { setCompacting(true); try { await compactThread(threadId); } finally { setCompacting(false); } }
  return <section className="model-picker"><button type="button" className="composer-tool-button model-trigger" onClick={() => onOpenChange(!open)} aria-expanded={open}><span>Model</span><strong>{models.find((item) => item.id === model)?.name || "Select model"}</strong><Icon name="chevronDown" /></button>{open && <div className="model-picker-popover"><div className="picker-heading"><strong>Model &amp; turn settings</strong><small>{models.length ? `${models.length} available in Codex` : "Loading model catalog…"}</small></div><div className="model-list" role="listbox" aria-label="Choose model">{models.map((item) => <button type="button" role="option" aria-selected={item.id === model} className={item.id === model ? "model-choice selected" : "model-choice"} key={item.id} onClick={() => save("codex-board.model", item.id, setModel)}><span>{item.name}</span>{item.id === model && <Icon name="check" />}</button>)}</div>{!model && <small className="model-required">Choose a model before sending.</small>}<div className="picker-fields"><label>Effort<select value={effort} onChange={(event) => save("codex-board.effort", event.target.value, setEffort)}><option value="">Model default</option>{efforts.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label>Summary<select value={summary} onChange={(event) => save("codex-board.summary", event.target.value, setSummary)}><option value="auto">Auto</option><option value="concise">Concise</option><option value="detailed">Detailed</option><option value="none">Off</option></select></label><label>Service tier<select value={tier} onChange={(event) => save("codex-board.serviceTier", event.target.value, setTier)}><option value="">Codex automatic</option>{tiers.map((item) => <option key={item} value={item}>{item}</option>)}</select></label></div><button className="compact-button" type="button" disabled={working || compacting} onClick={() => void compact()}>{compacting ? "Compacting…" : "Compact conversation"}</button></div>}</section>;
}

export function ChatPanel({ thread, events, queuedMessages, working, activeTurnId, onSend, onRemoveQueued, onSessionState, onFork, onRename, onClose }: ChatPanelProps) {
  const AUTO_FOLLOW_THRESHOLD = 12;
  const [session, setSession] = useState<ChatSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [requests, setRequests] = useState<PendingCodexRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openComposerTool, setOpenComposerTool] = useState<"model" | "attachment" | null>(null);
  const [imageAttachments, setImageAttachments] = useState<ImageAttachmentDraft[]>([]);
  const lastSequence = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const initialScrollPending = useRef(false);
  const copyResetTimer = useRef<number | null>(null);
  const [copiedItemId, setCopiedItemId] = useState<string | null>(null);
  const request = requests[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    lastSequence.current = events.at(-1)?.sequence || 0;
    initialScrollPending.current = true;
    followOutput.current = true;
    setLoading(true); setSession(null); setRequests([]); setError(null); setOpenComposerTool(null); setImageAttachments([]);
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

  useEffect(() => {
    if (!session || (!followOutput.current && !initialScrollPending.current)) return;
    bottomRef.current?.scrollIntoView({ behavior: initialScrollPending.current ? "auto" : "smooth", block: "end" });
    initialScrollPending.current = false;
  }, [session?.items, queuedMessages, request]);

  useEffect(() => () => {
    if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
  }, []);

  function updateFollowOutput() {
    const body = bodyRef.current;
    if (!body) return;
    const distanceFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
    followOutput.current = distanceFromBottom <= AUTO_FOLLOW_THRESHOLD;
  }

  async function copyMessage(itemId: string, value: string) {
    if (!value.trim()) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      setCopiedItemId(itemId);
      if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
      copyResetTimer.current = window.setTimeout(() => setCopiedItemId(null), 1400);
    } catch (cause) {
      setError(asCodexError(cause).message);
    }
  }

  function copyButton(item: ChatSession["items"][number]) {
    const copied = copiedItemId === item.id;
    return <button className="chat-item-copy" type="button" disabled={!item.text?.trim()} onClick={() => void copyMessage(item.id, item.text)} aria-label={copied ? "Message copied" : "Copy message"} title={copied ? "Copied" : "Copy message"}><Icon name={copied ? "check" : "copy"} /></button>;
  }
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
    <header className="chat-header"><button className="icon-button chat-back-button" onClick={onClose} aria-label="Back to board"><Icon name="chevronLeft" /></button><div className="chat-heading"><div className="chat-title-row"><h2>{title}</h2><span className={working ? "chat-state live" : "chat-state"}><i />{working ? "Working" : "Ready"}</span></div><p>{thread.cwd || "Local Codex thread"}{thread.forkedFromId ? " · Forked conversation" : ""}</p></div><button className="icon-button chat-fork-button" onClick={()=>onRename(thread.id)} aria-label="Rename conversation" title="Rename conversation"><Icon name="edit"/></button><button className="icon-button chat-fork-button" disabled={working || loading} onClick={() => onFork(thread.id)} aria-label="Fork conversation" title={working ? "Wait for the active turn to finish" : "Fork conversation"}><Icon name="fork" /></button></header>
    <div className="chat-body" ref={bodyRef} onScroll={updateFollowOutput}>
      {loading && <div className="chat-loading"><div className="spinner" /><span>Loading conversation…</span></div>}
      {!loading && error && <div className="chat-error" role="alert">{error}<button onClick={() => setError(null)}>×</button></div>}
      {!loading && session?.items.length === 0 && <div className="chat-empty"><h3>Continue this thread</h3><p>Send a message below. Codex will work in the thread&apos;s existing project.</p></div>}
      {session?.items.filter((item) => item.kind !== "reasoning" && item.kind !== "plan" && item.kind !== "activity").map((item) => item.kind === "activity" ? <details key={item.id} className="chat-item activity has-copy">{copyButton(item)}<summary><span>{item.title || "Activity"}</span>{item.status && <small>{item.status}</small>}</summary><div className="chat-item-text">{item.text || "Working…"}</div></details> : <article key={item.id} className={`chat-item ${item.kind} has-copy`}>{copyButton(item)}{item.title && <div className="chat-item-title"><span>{item.title}</span>{item.status && <small>{item.status}</small>}</div>}<div className="chat-item-text"><MarkdownContent>{item.text || (item.kind === "assistant" ? "Thinking…" : "Working…")}</MarkdownContent></div></article>)}
      {working && <div className="working-indicator"><span /><span /><span /><em>Codex is working</em></div>}
      {queuedMessages.length > 0 && <section className="message-queue"><div className="queue-heading"><strong>Message queue</strong><span>{queuedMessages.length} waiting</span></div>{queuedMessages.map((message, index) => <div className="queued-message" key={message.id}><span>{index + 1}</span><p>{message.text || `${message.imageUrls?.length ?? (message.imageUrl ? 1 : 0)} images attached`}</p><button aria-label="Remove queued message" onClick={() => onRemoveQueued(thread.id, message.id)}>×</button></div>)}</section>}
      {request && <ApprovalPrompt request={request} busy={approvalBusy} onResolve={(result) => void resolveRequest(result)} />}
      <div ref={bottomRef} />
    </div>
    <ChatComposer key={thread.id} threadId={thread.id} working={working} activeTurnId={activeTurnId} loading={loading} onSend={onSend} onStop={stop} onError={setError} attachments={imageAttachments} onRemoveAttachment={(id) => setImageAttachments((current) => current.filter((attachment) => attachment.id !== id))} onClearAttachments={() => setImageAttachments([])} controls={<><TurnSettingsBar threadId={thread.id} working={working} open={openComposerTool === "model"} onOpenChange={(open) => setOpenComposerTool(open ? "model" : null)} /><ImageAttachmentButton onSelect={(selected) => setImageAttachments((current) => [...current, ...selected])} onError={setError} disabled={loading} open={openComposerTool === "attachment"} onOpenChange={(open) => setOpenComposerTool(open ? "attachment" : null)} selectedCount={imageAttachments.length} /></>} />
  </section></div>;
}
