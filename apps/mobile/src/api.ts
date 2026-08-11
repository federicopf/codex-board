import type { BoardConfig, CodexEvent, JsonValue, PairingCredential, RemoteHealth, ThreadDto } from "@codex-board/protocol";

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
  board() { return this.request<BoardConfig>("/v1/board"); }
  thread(id: string) { return this.request<Record<string, JsonValue>>(`/v1/threads/${encodeURIComponent(id)}`); }
  send(id: string, text: string) { return this.request<JsonValue>(`/v1/threads/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ text }) }); }
  interrupt(id: string, turnId: string) { return this.request<void>(`/v1/threads/${encodeURIComponent(id)}/interrupt`, { method: "POST", body: JSON.stringify({ turnId }) }); }

  subscribe(onEvent: (event: CodexEvent) => void, onConnection: (connected: boolean) => void): () => void {
    const wsUrl = this.credential.baseUrl.replace(/^http/, "ws") + "/v1/events";
    const Socket = WebSocket as unknown as WebSocketWithHeaders;
    const socket = new Socket(wsUrl, null, { headers: { Authorization: `Bearer ${this.credential.token}` } });
    socket.onopen = () => onConnection(true);
    socket.onclose = () => onConnection(false);
    socket.onerror = () => onConnection(false);
    socket.onmessage = (message) => {
      try { onEvent(JSON.parse(String(message.data)) as CodexEvent); } catch { /* ignore malformed gateway frames */ }
    };
    return () => socket.close();
  }
}
