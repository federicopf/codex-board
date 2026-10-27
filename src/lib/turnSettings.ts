import { useSyncExternalStore } from "react";
import { ThreadTurnSettingsSync, type TurnSettings } from "@codex-board/protocol";
import { setTurnSettings, setThreadTurnSettings } from "../api";

export const turnPreferences = new ThreadTurnSettingsSync(setTurnSettings, setThreadTurnSettings, {
  model: localStorage.getItem("codex-board.model") || "",
  effort: localStorage.getItem("codex-board.effort") || "",
  summary: localStorage.getItem("codex-board.summary") || "auto",
  serviceTier: localStorage.getItem("codex-board.serviceTier") || "",
});

turnPreferences.subscribe(() => {
  const { settings } = turnPreferences.getSnapshot();
  try {
    for (const key of ["model", "effort", "summary", "serviceTier"] as const) {
      localStorage.setItem(`codex-board.${key}`, settings[key] || "");
    }
  } catch { /* The backend remains authoritative when the local cache is full. */ }
});

export function useTurnPreferences(threadId: string) {
  const store = turnPreferences.thread(threadId);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { ...state, update: (patch: TurnSettings) => { void store.update(patch).catch(() => undefined); } };
}
