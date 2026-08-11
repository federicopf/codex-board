import * as SecureStore from "expo-secure-store";
import type { PairingCredential } from "@codex-board/protocol";

const CREDENTIAL_KEY = "codex-board.remote.v1";

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
