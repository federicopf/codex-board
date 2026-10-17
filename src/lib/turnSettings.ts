import { useSyncExternalStore } from "react";
import { TurnSettingsSync, type TurnSettings } from "@codex-board/protocol";
import { setTurnSettings } from "../api";

export const turnPreferences = new TurnSettingsSync(setTurnSettings, {
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

export function useTurnPreferences() {
  const state = useSyncExternalStore(turnPreferences.subscribe, turnPreferences.getSnapshot);
  return { ...state, update: (patch: TurnSettings) => { void turnPreferences.update(patch).catch(() => undefined); } };
}
