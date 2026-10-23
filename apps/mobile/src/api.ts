import type { Automation, BoardConfig, BoardNotification, CodexEvent, CreateAutomationInput, CreateThreadInput, ForkThreadInput, JsonValue, PairingCredential, PendingRemoteRequest, QueuedMessage, RemoteHealth, SendOutcome, ThreadDto, TurnSettings } from "@codex-board/protocol";
import { loadLegacyTurnSettings, saveLegacyTurnSettings } from "./connection";

type WebSocketWithHeaders = new (url: string, protocols?: string | string[] | null, options?: { headers?: Record<string, string> }) => WebSocket;

export class BoardApi {
  sharedTurnSettings: boolean | null = null;
  private localTurnSettings: TurnSettings = {};
  private localSettingsLoaded: Promise<void> | null = null;
  private settingsRevisionOffset = 0;
  constructor(private readonly credential: PairingCredential) {}

  private async resolveBoard(config: BoardConfig): Promise<BoardConfig> {
    this.sharedTurnSettings = Boolean(config.turnSettings);
    if (!this.sharedTurnSettings) {
      this.localSettingsLoaded ??= loadLegacyTurnSettings(this.credential.baseUrl).then(settings=>{this.localTurnSettings=settings;});
      await this.localSettingsLoaded;
    }
    return {
      ...config,
      turnSettings: config.turnSettings || this.localTurnSettings,
      revision: config.revision + this.settingsRevisionOffset,
    };
  }

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
      if (response.status === 413) throw new Error("Photos exceed the upload limit (32 MB on the updated PC). Choose fewer or smaller images.");
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error || `Gateway returned ${response.status}`);
    }
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }

  health() { return this.request<RemoteHealth>("/v1/health"); }
  imageSource(path: string) { return { uri: `${this.credential.baseUrl}/v1/image?path=${encodeURIComponent(path)}`, headers: { Authorization: `Bearer ${this.credential.token}` } }; }
  threads() { return this.request<ThreadDto[]>("/v1/threads"); }
  rateLimits() { return this.request<JsonValue>("/v1/rate-limits"); }
  models() { return this.request<JsonValue>("/v1/models"); }
  createThread(input: CreateThreadInput) { return this.request<ThreadDto>("/v1/threads/new", { method: "POST", body: JSON.stringify(input) }); }
  forkThread(id: string, input: ForkThreadInput) { return this.request<ThreadDto>(`/v1/threads/${encodeURIComponent(id)}/fork`, { method: "POST", body: JSON.stringify(input) }); }
  async board() { return this.resolveBoard(await this.request<BoardConfig>("/v1/board")); }
  async updateBoard(config: BoardConfig) { return this.resolveBoard(await this.request<BoardConfig>("/v1/board", { method: "PUT", body: JSON.stringify(config) })); }
  async updateTurnSettings(settings: TurnSettings) {
    if (this.sharedTurnSettings === null) await this.board();
    if (this.sharedTurnSettings === false) {
      const next = { ...this.localTurnSettings, ...settings };
      await saveLegacyTurnSettings(this.credential.baseUrl, next);
      this.localTurnSettings = next;
      this.settingsRevisionOffset++;
      return this.board();
    }
    return this.resolveBoard(await this.request<BoardConfig>("/v1/turn-settings", { method: "PUT", body: JSON.stringify(settings) }));
  }
  thread(id: string, page?: { limit: number; before?: number; unit?: "items" }) {
    const query = page ? `?limit=${page.limit}${page.before === undefined ? "" : `&before=${page.before}`}${page.unit ? `&unit=${page.unit}` : ""}` : "";
    return this.request<Record<string, JsonValue>>(`/v1/threads/${encodeURIComponent(id)}${query}`);
  }
  archive(id: string) { return this.request<void>(`/v1/threads/${encodeURIComponent(id)}/archive`, { method: "POST" }); }
  rename(id: string, newName: string) { return this.request<ThreadDto>(`/v1/threads/${encodeURIComponent(id)}/name`, { method: "PUT", body: JSON.stringify({ newName }) }); }
  send(id: string, text: string, imageUrls?: string[], settings?: TurnSettings) { return this.request<SendOutcome>(`/v1/threads/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ text, imageUrls: imageUrls?.length ? imageUrls : null, settings: settings || null }) }); }
  interrupt(id: string, turnId: string) { return this.request<void>(`/v1/threads/${encodeURIComponent(id)}/interrupt`, { method: "POST", body: JSON.stringify({ turnId }) }); }
  compact(id: string) { return this.request<JsonValue>(`/v1/threads/${encodeURIComponent(id)}/compact`, { method: "POST" }); }
  queues() { return this.request<Record<string, QueuedMessage[]>>("/v1/queues"); }
  removeQueued(id: string, messageId: string) { return this.request<void>(`/v1/threads/${encodeURIComponent(id)}/queue/${encodeURIComponent(messageId)}`, { method: "DELETE" }); }
  requests() { return this.request<PendingRemoteRequest[]>("/v1/requests"); }
  respond(requestId: JsonValue, result: JsonValue) { return this.request<void>("/v1/requests/respond", { method: "POST", body: JSON.stringify({ requestId, result }) }); }
  automations() { return this.request<Automation[]>("/v1/automations"); }
  createAutomation(input: CreateAutomationInput) { return this.request<Automation>("/v1/automations", { method: "POST", body: JSON.stringify(input) }); }
  async retryAutomation(id: string) {
    try { return await this.request<void>(`/v1/automations/${encodeURIComponent(id)}/retry`, { method: "POST" }); }
    catch (error) {
      if (error instanceof Error && /404|405/.test(error.message)) throw new Error("Aggiorna Codex Board sul PC per rilanciare le automazioni.");
      throw error;
    }
  }
  async updateAutomation(id: string, input: CreateAutomationInput) {
    try { return await this.request<Automation>(`/v1/automations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }); }
    catch (error) {
      if (error instanceof Error && /404|405/.test(error.message)) throw new Error("Update Codex Board on your PC to edit workflows from mobile.");
      throw error;
    }
  }
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
