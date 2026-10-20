import { useRef, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";

/** Measure the actual viewport origin, including safe areas and any connection banner. */
export function ChatKeyboardFrame({ children }: { children: ReactNode }) {
  const viewport = useRef<View>(null);
  const [top, setTop] = useState(0);
  return <View ref={viewport} style={styles.fill} onLayout={() => {
    viewport.current?.measureInWindow((_x, y) => setTop(y));
  }}>
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={top}>
      {children}
    </KeyboardAvoidingView>
  </View>;
}
const styles = StyleSheet.create({ fill: { flex: 1, minHeight: 0 } });
