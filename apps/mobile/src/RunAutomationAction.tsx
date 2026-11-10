import { useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text } from "react-native";
import { MobileIcon } from "./MobileIcon";
import { colors } from "./theme";

export function RunAutomationAction({ name, onRun, disabled = false }: { name: string; onRun: () => Promise<void>; disabled?: boolean }) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  function confirm() {
    Alert.alert("Run automation now?", `Run “${name}” with its saved settings? This may change the linked chat or project. The regular schedule and pause state will not change.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Run now", onPress: () => {
        if (pending.current) return;
        pending.current = true; setBusy(true);
        void onRun()
          .catch(error => Alert.alert("Could not run automation", error instanceof Error ? error.message : String(error)))
          .finally(() => { pending.current = false; setBusy(false); });
      } },
    ]);
  }
  return <Pressable accessibilityRole="button" accessibilityLabel={`Run ${name} now`} disabled={disabled || busy} style={[styles.button, (disabled || busy) && styles.disabled]} onPress={confirm}>
    {busy ? <ActivityIndicator color={colors.primary}/> : <MobileIcon name="play" size={18} color={colors.primary}/>}
    <Text style={styles.label}>Run now</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  button: { minHeight: 48, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  label: { color: colors.primary, fontSize: 12, fontWeight: "700" },
  disabled: { opacity: 0.45 },
});
