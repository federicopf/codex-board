import type { Automation, BoardConfig, BoardNotification, CodexEvent, CreateAutomationInput, CreateThreadInput, JsonValue, PairingCredential, PendingRemoteRequest, QueuedMessage, RemoteHealth, SendOutcome, ThreadDto } from "@codex-board/protocol";

type WebSocketWithHeaders = new (url: string, protocols?: string | string[] | null, options?: { headers?: Record<string, string> }) => WebSocket;

export class BoardApi {
  constructor(private readonly credential: PairingCredential) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.credential.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.credential.token}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error || `Gateway returned ${response.status}`);
    }
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }

  health() { return this.request<RemoteHealth>("/v1/health"); }
  threads() { return this.request<ThreadDto[]>("/v1/threads"); }
  createThread(input: CreateThreadInput) { return this.request<ThreadDto>("/v1/threads/new", { method: "POST", body: JSON.stringify(input) }); }
  board() { return this.request<BoardConfig>("/v1/board"); }
  updateBoard(config: BoardConfig) { return this.request<BoardConfig>("/v1/board", { method: "PUT", body: JSON.stringify(config) }); }
  thread(id: string) { return this.request<Record<string, JsonValue>>(`/v1/threads/${encodeURIComponent(id)}`); }
  rename(id: string, newName: string) { return this.request<ThreadDto>(`/v1/threads/${encodeURIComponent(id)}/name`, { method: "PUT", body: JSON.stringify({ newName }) }); }
  send(id: string, text: string) { return this.request<SendOutcome>(`/v1/threads/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ text }) }); }
  interrupt(id: string, turnId: string) { return this.request<void>(`/v1/threads/${encodeURIComponent(id)}/interrupt`, { method: "POST", body: JSON.stringify({ turnId }) }); }
  queues() { return this.request<Record<string, QueuedMessage[]>>("/v1/queues"); }
  removeQueued(id: string, messageId: string) { return this.request<void>(`/v1/threads/${encodeURIComponent(id)}/queue/${encodeURIComponent(messageId)}`, { method: "DELETE" }); }
  requests() { return this.request<PendingRemoteRequest[]>("/v1/requests"); }
  respond(requestId: JsonValue, result: JsonValue) { return this.request<void>("/v1/requests/respond", { method: "POST", body: JSON.stringify({ requestId, result }) }); }
  automations() { return this.request<Automation[]>("/v1/automations"); }
  createAutomation(input: CreateAutomationInput) { return this.request<Automation>("/v1/automations", { method: "POST", body: JSON.stringify(input) }); }
  setAutomationEnabled(id: string, enabled: boolean) { return this.request<Automation>(`/v1/automations/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ enabled }) }); }
  deleteAutomation(id: string) { return this.request<void>(`/v1/automations/${encodeURIComponent(id)}`, { method: "DELETE" }); }
  notifications() { return this.request<BoardNotification[]>("/v1/notifications"); }
  markNotificationsRead(id?: string) { return this.request<void>("/v1/notifications/read", { method: "POST", body: JSON.stringify({ id }) }); }
  clearNotifications() { return this.request<void>("/v1/notifications", { method: "DELETE" }); }

  subscribe(onEvent: (event: CodexEvent) => void, onConnection: (connected: boolean) => void): () => void {
    const wsUrl = this.credential.baseUrl.replace(/^http/, "ws") + "/v1/events";
    const Socket = WebSocket as unknown as WebSocketWithHeaders;
    let socket: WebSocket | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const connect = () => {
      if (stopped) return;
      socket = new Socket(wsUrl, null, { headers: { Authorization: `Bearer ${this.credential.token}` } });
      socket.onopen = () => { attempts = 0; onConnection(true); };
      socket.onclose = () => {
        onConnection(false);
        if (!stopped) retry = setTimeout(connect, Math.min(30_000, 1_000 * 2 ** attempts++));
      };
      socket.onerror = () => onConnection(false);
      socket.onmessage = (message) => {
        try { onEvent(JSON.parse(String(message.data)) as CodexEvent); } catch { /* ignore malformed gateway frames */ }
      };
    };
    connect();
    return () => { stopped = true; if (retry) clearTimeout(retry); socket?.close(); };
  }
}
