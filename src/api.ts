import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CodexError, CodexEvent, CodexThread, JsonValue, ThreadDto } from "./types";

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
