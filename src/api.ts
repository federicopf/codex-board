import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CodexError, CodexEvent, CodexThread, JsonValue, ThreadDto } from "./types";

export interface GatewayInfo { running: boolean; port: number; token: string; error?: string | null; }
export interface TailscaleInfo { installed: boolean; online: boolean; dnsName?: string | null; baseUrl?: string | null; error?: string | null; }
export interface BoardConfig { categories: string[]; approvalMode: "auto" | "ask"; revision: number; }

export async function listThreads(): Promise<ThreadDto[]> {
  return invoke<ThreadDto[]>("list_threads");
}

export async function renameThread(threadId: string, newName: string): Promise<ThreadDto> {
  return invoke<ThreadDto>("rename_thread", { threadId, newName });
}

export async function openThread(threadId: string): Promise<void> {
  await openUrl(`codex://threads/${encodeURIComponent(threadId)}`);
}

export async function loadThread(threadId: string): Promise<CodexThread> {
  return invoke<CodexThread>("load_thread", { threadId });
}

export async function sendMessage(threadId: string, text: string): Promise<JsonValue> {
  return invoke<JsonValue>("send_message", { threadId, text });
}

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

export function asCodexError(error: unknown): CodexError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error
  ) {
    return error as CodexError;
  }
  return {
    code: "REQUEST_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}
