import { useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text } from "react-native";
import { MobileIcon } from "./MobileIcon";
import { colors } from "./theme";

export function RetryAutomationAction({ onRetry, onAccepted, disabled = false }: {
  onRetry: () => Promise<void>; onAccepted?: () => void; disabled?: boolean;
}) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  function confirm() {
    Alert.alert("Retry automation?", "Uses current settings, or resumes an existing queued attempt unchanged. Work may have been partially completed. The regular schedule and pause state will not change.", [
      { text: "Cancel", style: "cancel" },
      { text: "Retry", onPress: () => {
        if (pending.current) return;
        pending.current = true; setBusy(true);
        void onRetry().then(() => { setSent(true); onAccepted?.(); })
          .catch(error => Alert.alert("Could not retry", error instanceof Error ? error.message : String(error)))
          .finally(() => { pending.current = false; setBusy(false); });
      } },
    ]);
  }
  return <Pressable accessibilityRole="button" accessibilityLabel="Retry automation" disabled={disabled || busy || sent} style={[styles.button, (disabled || busy || sent) && styles.disabled]} onPress={confirm}>
    {busy ? <ActivityIndicator color={colors.primary}/> : <MobileIcon name="rotate-cw" size={18} color={colors.primary}/>}
    <Text style={styles.label}>{sent ? "Retry requested" : "Retry"}</Text>
  </Pressable>;
}
const styles = StyleSheet.create({
  button: { minHeight: 48, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  label: { color: colors.primary, fontSize: 12, fontWeight: "700" },
  disabled: { opacity: 0.45 },
});
