import * as SecureStore from "expo-secure-store";
import type { PairingCredential } from "@codex-board/protocol";

const CREDENTIAL_KEY = "codex-board.remote.v1";
const TOUR_KEY = "codex-board.tour.v1";
const BOARD_KEY = "codex-board.project-board.v1";

export async function loadCredential(): Promise<PairingCredential | null> {
  const value = await SecureStore.getItemAsync(CREDENTIAL_KEY);
  if (!value) return null;
  try { return JSON.parse(value) as PairingCredential; }
  catch { await SecureStore.deleteItemAsync(CREDENTIAL_KEY); return null; }
}

export async function saveCredential(value: PairingCredential): Promise<void> {
  await SecureStore.setItemAsync(CREDENTIAL_KEY, JSON.stringify(value), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearCredential(): Promise<void> {
  await SecureStore.deleteItemAsync(CREDENTIAL_KEY);
}
export async function hasSeenTour(): Promise<boolean> { return (await SecureStore.getItemAsync(TOUR_KEY)) === "done"; }
export async function markTourSeen(): Promise<void> { await SecureStore.setItemAsync(TOUR_KEY, "done"); }
export async function loadSelectedBoard(): Promise<string | null> { return SecureStore.getItemAsync(BOARD_KEY); }
export async function saveSelectedBoard(value: string): Promise<void> { await SecureStore.setItemAsync(BOARD_KEY, value); }
