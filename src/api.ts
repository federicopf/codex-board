import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CodexError, ThreadDto } from "./types";

export async function listThreads(): Promise<ThreadDto[]> {
  return invoke<ThreadDto[]>("list_threads");
}

export async function renameThread(threadId: string, newName: string): Promise<void> {
  return invoke("rename_thread", { threadId, newName });
}

export async function openThread(threadId: string): Promise<void> {
  await openUrl(`codex://threads/${encodeURIComponent(threadId)}`);
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
