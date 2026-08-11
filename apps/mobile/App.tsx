import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useColorScheme, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { categoryFromTitle, displayTitle, parsePairingPayload, type BoardConfig, type JsonValue, type PairingCredential, type ThreadDto } from "@codex-board/protocol";
import { BoardApi } from "./src/api";
import { clearCredential, loadCredential, saveCredential } from "./src/connection";

type JsonObject = Record<string, JsonValue>;
const object = (value: JsonValue | undefined): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const string = (value: JsonValue | undefined): string => typeof value === "string" ? value : "";

interface ChatLine { id: string; role: "user" | "assistant" | "activity"; text: string; }

function conversation(thread: JsonObject | null): ChatLine[] {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const lines: ChatLine[] = [];
  for (const rawTurn of turns) {
    const items = object(rawTurn).items;
    if (!Array.isArray(items)) continue;
    for (const rawItem of items) {
      const item = object(rawItem);
      const type = string(item.type);
      const id = string(item.id) || `${lines.length}`;
      if (type === "userMessage") {
        const content = Array.isArray(item.content) ? item.content.map((part) => string(object(part).text)).filter(Boolean).join("\n") : string(item.content);
        lines.push({ id, role: "user", text: content });
      } else if (type === "agentMessage") lines.push({ id, role: "assistant", text: string(item.text) });
      else if (type === "plan" || type === "reasoning") lines.push({ id, role: "activity", text: string(item.text) || "Codex activity" });
    }
  }
  return lines;
}

function isWorking(thread: ThreadDto): boolean { return string(object(thread.status).type) === "active"; }

function PairScreen({ onPair }: { onPair: (credential: PairingCredential) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  async function pair(raw: string) {
    setBusy(true);
    try { await onPair(parsePairingPayload(raw)); }
    catch (error) { Alert.alert("Pairing failed", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  if (scanning) return <View style={styles.scanner}><CameraView style={StyleSheet.absoluteFill} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => { setScanning(false); void pair(data); }} /><SafeAreaView style={styles.scannerOverlay}><Text style={styles.scannerTitle}>Scan Codex Board</Text><View style={styles.scanFrame} /><Pressable style={styles.secondaryButton} onPress={() => setScanning(false)}><Text style={styles.secondaryButtonText}>Cancel</Text></Pressable></SafeAreaView></View>;

  return <SafeAreaView style={styles.pairPage}><View style={styles.logo}><View style={[styles.logoBar, { height: 14 }]} /><View style={[styles.logoBar, { height: 27 }]} /><View style={[styles.logoBar, { height: 20 }]} /></View><Text style={styles.title}>Codex Board</Text><Text style={styles.subtitle}>Connect securely to the Board running on your PC through Tailscale.</Text><Pressable style={styles.primaryButton} onPress={async () => { if (!permission?.granted) { const result = await requestPermission(); if (!result.granted) return; } setScanning(true); }}><Text style={styles.primaryButtonText}>Scan pairing QR</Text></Pressable><Text style={styles.or}>or paste the pairing code</Text><TextInput style={styles.input} value={value} onChangeText={setValue} multiline autoCapitalize="none" autoCorrect={false} placeholder="Pairing URL or JSON" placeholderTextColor="#777" /><Pressable disabled={busy || !value.trim()} style={[styles.primaryButton, (busy || !value.trim()) && styles.disabled]} onPress={() => void pair(value)}>{busy ? <ActivityIndicator color="white" /> : <Text style={styles.primaryButtonText}>Connect</Text>}</Pressable></SafeAreaView>;
}

function Chat({ thread, api, onClose }: { thread: ThreadDto; api: BoardApi; onClose: () => void }) {
  const [loaded, setLoaded] = useState<JsonObject | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const lines = useMemo(() => conversation(loaded), [loaded]);
  const refresh = useCallback(() => void api.thread(thread.id).then(setLoaded).catch((error) => Alert.alert("Chat unavailable", error.message)), [api, thread.id]);
  useEffect(refresh, [refresh]);
  useEffect(() => api.subscribe((event) => { const params = object(event.params); if (string(params.threadId) === thread.id) refresh(); }, () => {}), [api, refresh, thread.id]);

  async function send() {
    const text = draft.trim(); if (!text || busy) return;
    setBusy(true);
    try { await api.send(thread.id, text); setDraft(""); refresh(); }
    catch (error) { Alert.alert("Could not send", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <Modal animationType="slide"><SafeAreaView style={styles.page}><View style={styles.header}><Pressable onPress={onClose}><Text style={styles.back}>‹ Board</Text></Pressable><View style={styles.headerCopy}><Text style={styles.headerTitle} numberOfLines={1}>{displayTitle(thread.name, thread.preview)}</Text><Text style={styles.headerMeta} numberOfLines={1}>{thread.cwd}</Text></View></View><FlatList style={styles.chat} contentContainerStyle={styles.chatContent} data={lines} keyExtractor={(item) => item.id} ListEmptyComponent={<Text style={styles.empty}>No messages yet.</Text>} renderItem={({ item }) => <View style={[styles.bubble, styles[`bubble_${item.role}`]]}><Text style={[styles.bubbleText, item.role === "user" && styles.userText]}>{item.text || "…"}</Text></View>} /><KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}><View style={styles.composer}><TextInput value={draft} onChangeText={setDraft} style={styles.composerInput} placeholder="Message Codex…" placeholderTextColor="#777" multiline /><Pressable disabled={!draft.trim() || busy} style={[styles.send, (!draft.trim() || busy) && styles.disabled]} onPress={() => void send()}><Text style={styles.primaryButtonText}>Send</Text></Pressable></View></KeyboardAvoidingView></SafeAreaView></Modal>;
}

function Board({ credential, onDisconnect }: { credential: PairingCredential; onDisconnect: () => Promise<void> }) {
  const api = useMemo(() => new BoardApi(credential), [credential]);
  const [threads, setThreads] = useState<ThreadDto[]>([]);
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [selected, setSelected] = useState<ThreadDto | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => { try { const [nextThreads, nextConfig] = await Promise.all([api.threads(), api.board()]); setThreads(nextThreads); setConfig(nextConfig); } catch (error) { Alert.alert("PC unavailable", error instanceof Error ? error.message : String(error)); } finally { setLoading(false); } }, [api]);
  useEffect(() => { void refresh(); return api.subscribe((event) => { if (event.method.startsWith("thread/") || event.method.startsWith("board/") || event.method === "turn/completed" || event.method === "turn/started") void refresh(); }, setConnected); }, [api, refresh]);
  const discovered = [...new Set(threads.map((thread) => categoryFromTitle(thread.name)))];
  const categories = [...(config?.categories || []), ...discovered.filter((value) => !config?.categories.includes(value))];

  return <SafeAreaView style={styles.page}><View style={styles.header}><View style={styles.headerCopy}><Text style={styles.headerTitle}>Codex Board</Text><Text style={styles.headerMeta}><Text style={{ color: connected ? "#43b77a" : "#d99a45" }}>●</Text> {connected ? "Live through Tailscale" : "Reconnecting…"}</Text></View><Pressable onPress={() => void refresh()}><Text style={styles.headerAction}>Refresh</Text></Pressable><Pressable onPress={() => void onDisconnect()}><Text style={styles.headerAction}>Unpair</Text></Pressable></View>{loading ? <View style={styles.center}><ActivityIndicator /></View> : <ScrollView horizontal pagingEnabled={false} contentContainerStyle={styles.columns} showsHorizontalScrollIndicator={false}>{categories.map((category) => { const items = threads.filter((thread) => categoryFromTitle(thread.name) === category); return <View style={styles.column} key={category}><View style={styles.columnHeader}><Text style={styles.columnTitle}>{category}</Text><Text style={styles.count}>{items.length}</Text></View><ScrollView>{items.map((thread) => <Pressable key={thread.id} style={[styles.card, isWorking(thread) && styles.workingCard]} onPress={() => setSelected(thread)}><Text style={styles.cardTitle}>{displayTitle(thread.name, thread.preview)}</Text>{thread.preview && <Text style={styles.cardPreview} numberOfLines={3}>{thread.preview}</Text>}<Text style={[styles.cardStatus, isWorking(thread) && styles.workingText]}>{isWorking(thread) ? "● Codex is working" : "Open chat"}</Text></Pressable>)}</ScrollView></View>; })}</ScrollView>}{selected && <Chat thread={selected} api={api} onClose={() => setSelected(null)} />}</SafeAreaView>;
}

function Root() {
  const [credential, setCredential] = useState<PairingCredential | null | undefined>(undefined);
  const dark = useColorScheme() === "dark";
  useEffect(() => { void loadCredential().then(setCredential); }, []);
  async function pair(next: PairingCredential) { const api = new BoardApi(next); await api.health(); await saveCredential(next); setCredential(next); }
  async function disconnect() { await clearCredential(); setCredential(null); }
  if (credential === undefined) return <View style={styles.center}><ActivityIndicator /></View>;
  return <><StatusBar style={dark ? "light" : "dark"} />{credential ? <Board credential={credential} onDisconnect={disconnect} /> : <PairScreen onPair={pair} />}</>;
}

export default function App() { return <SafeAreaProvider><Root /></SafeAreaProvider>; }

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#f4f5f7" }, center: { flex: 1, alignItems: "center", justifyContent: "center" },
  pairPage: { flex: 1, padding: 28, justifyContent: "center", backgroundColor: "#f4f5f7" }, logo: { width: 52, height: 52, borderRadius: 14, backgroundColor: "#20242d", flexDirection: "row", alignItems: "flex-end", gap: 4, padding: 12, alignSelf: "center" },
  logoBar: { flex: 1, borderRadius: 2, backgroundColor: "white" },
  title: { marginTop: 18, textAlign: "center", fontSize: 28, fontWeight: "700", color: "#202124" }, subtitle: { marginVertical: 12, textAlign: "center", color: "#6f7480", fontSize: 15, lineHeight: 22 }, or: { margin: 16, textAlign: "center", color: "#888", fontSize: 12 },
  primaryButton: { minHeight: 50, marginTop: 12, borderRadius: 12, backgroundColor: "#5869df", alignItems: "center", justifyContent: "center", paddingHorizontal: 18 }, primaryButtonText: { color: "white", fontWeight: "700" }, secondaryButton: { minHeight: 46, borderRadius: 12, backgroundColor: "white", alignItems: "center", justifyContent: "center", paddingHorizontal: 22 }, secondaryButtonText: { color: "#202124", fontWeight: "700" }, disabled: { opacity: 0.45 }, input: { minHeight: 82, borderWidth: 1, borderColor: "#d7d9df", borderRadius: 12, padding: 12, color: "#202124", backgroundColor: "white", textAlignVertical: "top" },
  scanner: { flex: 1, backgroundColor: "black" }, scannerOverlay: { flex: 1, alignItems: "center", justifyContent: "space-between", padding: 28 }, scannerTitle: { color: "white", fontSize: 20, fontWeight: "700" }, scanFrame: { width: 250, height: 250, borderWidth: 3, borderColor: "white", borderRadius: 22 },
  header: { minHeight: 64, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: "#d9dbe1", backgroundColor: "white" }, headerCopy: { flex: 1 }, headerTitle: { color: "#202124", fontSize: 17, fontWeight: "700" }, headerMeta: { marginTop: 3, color: "#777d88", fontSize: 11 }, headerAction: { color: "#5869df", fontSize: 12, fontWeight: "600" }, back: { color: "#5869df", fontSize: 16 },
  columns: { padding: 14, gap: 12 }, column: { width: 310, borderRadius: 14, backgroundColor: "#e9ebef", padding: 10 }, columnHeader: { height: 42, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4 }, columnTitle: { color: "#31343b", fontSize: 13, fontWeight: "700" }, count: { color: "#777d88", backgroundColor: "white", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, fontSize: 11 },
  card: { marginBottom: 9, padding: 14, borderRadius: 11, borderWidth: 1, borderColor: "#dddfe5", backgroundColor: "white" }, workingCard: { borderColor: "#7d8aeb" }, cardTitle: { color: "#202124", fontSize: 14, fontWeight: "600" }, cardPreview: { marginTop: 7, color: "#747985", fontSize: 12, lineHeight: 17 }, cardStatus: { marginTop: 11, color: "#5869df", fontSize: 10, fontWeight: "600" }, workingText: { color: "#5869df" }, empty: { textAlign: "center", color: "#777", marginTop: 50 },
  chat: { flex: 1 }, chatContent: { padding: 16, gap: 10 }, bubble: { maxWidth: "88%", borderRadius: 13, paddingHorizontal: 13, paddingVertical: 10 }, bubble_user: { alignSelf: "flex-end", backgroundColor: "#5869df", borderBottomRightRadius: 4 }, bubble_assistant: { alignSelf: "flex-start", backgroundColor: "white", borderBottomLeftRadius: 4 }, bubble_activity: { alignSelf: "stretch", maxWidth: "100%", backgroundColor: "#e7e9ee" }, bubbleText: { color: "#272a31", fontSize: 14, lineHeight: 20 }, userText: { color: "white" },
  composer: { flexDirection: "row", gap: 9, alignItems: "flex-end", padding: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: "#d9dbe1", backgroundColor: "white" }, composerInput: { flex: 1, maxHeight: 120, minHeight: 44, padding: 11, borderWidth: 1, borderColor: "#d9dbe1", borderRadius: 12, color: "#202124" }, send: { minHeight: 44, minWidth: 64, paddingHorizontal: 14, borderRadius: 10, backgroundColor: "#5869df", alignItems: "center", justifyContent: "center" },
});
