import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CodexError, CodexEvent, CodexThread, JsonValue, QueuedMessage, SendOutcome, ThreadDto } from "./types";
import type { Automation, CreateAutomationInput } from "@codex-board/protocol";
import type { BoardNotification } from "@codex-board/protocol";

export interface GatewayInfo { running: boolean; port: number; token: string; error?: string | null; }
export interface TailscaleInfo { installed: boolean; online: boolean; dnsName?: string | null; baseUrl?: string | null; error?: string | null; }
export interface BoardConfig { categories: string[]; approvalMode: "auto" | "ask"; revision: number; }

export async function listThreads(): Promise<ThreadDto[]> {
  return invoke<ThreadDto[]>("list_threads");
}

export async function renameThread(threadId: string, newName: string): Promise<ThreadDto> {
  return invoke<ThreadDto>("rename_thread", { threadId, newName });
}
export async function createThread(cwd: string, category: string, title: string, prompt: string): Promise<ThreadDto> {
  return invoke<ThreadDto>("create_thread", { cwd, category, title, prompt });
}

export async function openThread(threadId: string): Promise<void> {
  await openUrl(`codex://threads/${encodeURIComponent(threadId)}`);
}

export async function loadThread(threadId: string): Promise<CodexThread> {
  return invoke<CodexThread>("load_thread", { threadId });
}

export async function sendMessage(threadId: string, text: string): Promise<SendOutcome> {
  return invoke<SendOutcome>("send_message", { threadId, text });
}

export async function getMessageQueues(): Promise<Record<string, QueuedMessage[]>> { return invoke("message_queues"); }
export async function removeQueuedMessage(threadId: string, messageId: string): Promise<boolean> { return invoke("remove_queued_message", { threadId, messageId }); }

export async function interruptTurn(threadId: string, turnId: string): Promise<void> {
  return invoke("interrupt_turn", { threadId, turnId });
}

export async function drainCodexEvents(): Promise<CodexEvent[]> {
  return invoke<CodexEvent[]>("drain_codex_events");
}

export async function respondToCodexRequest(requestId: JsonValue, result: JsonValue): Promise<void> {
  return invoke("respond_to_codex_request", { requestId, result });
}

export async function getGatewayInfo(): Promise<GatewayInfo> { return invoke<GatewayInfo>("gateway_info"); }
export async function getTailscaleStatus(): Promise<TailscaleInfo> { return invoke<TailscaleInfo>("tailscale_status"); }
export async function configureTailscaleServe(): Promise<TailscaleInfo> { return invoke<TailscaleInfo>("configure_tailscale_serve"); }
export async function getBoardConfig(): Promise<BoardConfig> { return invoke<BoardConfig>("get_board_config"); }
export async function setBoardConfig(config: BoardConfig): Promise<BoardConfig> { return invoke<BoardConfig>("set_board_config", { config }); }
export async function listAutomations(): Promise<Automation[]> { return invoke<Automation[]>("list_automations"); }
export async function createAutomation(input: CreateAutomationInput): Promise<Automation> { return invoke<Automation>("create_automation", { input }); }
export async function setAutomationEnabled(id: string, enabled: boolean): Promise<Automation> { return invoke<Automation>("set_automation_enabled", { id, input: { enabled } }); }
export async function deleteAutomation(id: string): Promise<boolean> { return invoke<boolean>("delete_automation", { id }); }
export async function listNotifications(): Promise<BoardNotification[]> { return invoke("list_notifications"); }
export async function markNotificationsRead(id?: string): Promise<void> { return invoke("mark_notifications_read", { id }); }
export async function clearNotifications(): Promise<void> { return invoke("clear_notifications"); }

export function userFacingErrorMessage(message: string): string {
  const normalized = message.toLocaleLowerCase();
  if (
    normalized.includes("os error 2") ||
    normalized.includes("impossibile trovare il file specificato") ||
    normalized.includes("the system cannot find the file specified")
  ) {
    return "A local file linked to this task is no longer available. Refresh the board; if the problem continues, this task may no longer have a readable Codex history.";
  }
  return message;
}

export function asCodexError(error: unknown): CodexError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error
  ) {
    const codexError = error as CodexError;
    return { ...codexError, message: userFacingErrorMessage(codexError.message) };
  }
  return {
    code: "REQUEST_FAILED",
    message: userFacingErrorMessage(error instanceof Error ? error.message : String(error)),
  };
}
