import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform,
  Pressable, ScrollView, StyleSheet, Text, TextInput, useColorScheme, View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  categoryFromTitle, displayTitle, parsePairingPayload,
  type BoardConfig, type JsonValue, type PairingCredential,
  type PendingRemoteRequest, type QueuedMessage, type ThreadDto,
} from "@codex-board/protocol";
import { BoardApi } from "./src/api";
import { clearCredential, loadCredential, saveCredential } from "./src/connection";

type JsonObject = Record<string, JsonValue>;
const object = (value: JsonValue | undefined): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const string = (value: JsonValue | undefined): string => typeof value === "string" ? value : "";
const requestThreadId = (request: PendingRemoteRequest) => string(object(request.params).threadId);

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
        const content = Array.isArray(item.content)
          ? item.content.map((part) => string(object(part).text)).filter(Boolean).join("\n")
          : string(item.content);
        lines.push({ id, role: "user", text: content });
      } else if (type === "agentMessage") {
        lines.push({ id, role: "assistant", text: string(item.text) });
      } else if (type === "plan" || type === "reasoning") {
        lines.push({ id, role: "activity", text: string(item.text) || "Codex activity" });
      }
    }
  }
  return lines;
}

function activeTurnId(thread: JsonObject | null): string | null {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const active = [...turns].reverse().find((turn) => string(object(turn).status) === "inProgress");
  return active ? string(object(active).id) || null : null;
}

function isWorking(thread: ThreadDto): boolean {
  return string(object(thread.status).type) === "active";
}

function taskName(category: string, title: string): string {
  return category === "Uncategorized" ? title : `${category} - ${title}`;
}

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

  if (scanning) {
    return <View style={styles.scanner}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => { setScanning(false); void pair(data); }}
      />
      <SafeAreaView style={styles.scannerOverlay}>
        <Text style={styles.scannerTitle}>Scan Codex Board</Text>
        <View style={styles.scanFrame} />
        <Pressable style={styles.secondaryButton} onPress={() => setScanning(false)}><Text>Cancel</Text></Pressable>
      </SafeAreaView>
    </View>;
  }

  return <SafeAreaView style={styles.pairPage}>
    <View style={styles.logo}><View style={[styles.logoBar, { height: 14 }]} /><View style={[styles.logoBar, { height: 27 }]} /><View style={[styles.logoBar, { height: 20 }]} /></View>
    <Text style={styles.title}>Codex Board</Text>
    <Text style={styles.subtitle}>Connect securely to the Board running on your PC through Tailscale.</Text>
    <Pressable style={styles.primaryButton} onPress={async () => {
      if (!permission?.granted) { const result = await requestPermission(); if (!result.granted) return; }
      setScanning(true);
    }}><Text style={styles.primaryButtonText}>Scan pairing QR</Text></Pressable>
    <Text style={styles.or}>or paste the pairing code</Text>
    <TextInput style={styles.input} value={value} onChangeText={setValue} multiline autoCapitalize="none" autoCorrect={false} placeholder="Pairing URL or JSON" />
    <Pressable disabled={busy || !value.trim()} style={[styles.primaryButton, (busy || !value.trim()) && styles.disabled]} onPress={() => void pair(value)}>
      {busy ? <ActivityIndicator color="white" /> : <Text style={styles.primaryButtonText}>Connect</Text>}
    </Pressable>
  </SafeAreaView>;
}

function RequestCard({ request, api, onDone }: { request: PendingRemoteRequest; api: BoardApi; onDone: () => void }) {
  const params = object(request.params);
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions = Array.isArray(params.questions) ? params.questions.map(object) : [];

  async function respond(result: JsonValue) {
    setBusy(true);
    try { await api.respond(request.requestId, result); onDone(); }
    catch (error) { Alert.alert("Could not respond", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  if (request.method === "item/tool/requestUserInput") {
    return <View style={styles.requestCard}><Text style={styles.requestTitle}>Codex needs your input</Text>
      {questions.map((question) => {
        const id = string(question.id);
        const options = Array.isArray(question.options) ? question.options.map(object) : [];
        return <View key={id} style={styles.question}><Text style={styles.questionText}>{string(question.question)}</Text>
          {options.map((option) => { const label = string(option.label); return <Pressable key={label} style={[styles.option, answers[id] === label && styles.optionSelected]} onPress={() => setAnswers((current) => ({ ...current, [id]: label }))}><Text>{label}</Text><Text style={styles.optionDescription}>{string(option.description)}</Text></Pressable>; })}
          {options.length === 0 && <TextInput style={styles.smallInput} value={answers[id] || ""} onChangeText={(value) => setAnswers((current) => ({ ...current, [id]: value }))} />}
        </View>;
      })}
      <Pressable disabled={busy || questions.some((question) => !answers[string(question.id)]?.trim())} style={[styles.primaryButton, styles.compactButton]} onPress={() => void respond({ answers: Object.fromEntries(questions.map((question) => [string(question.id), { answers: [answers[string(question.id)]] }])) })}><Text style={styles.primaryButtonText}>Continue</Text></Pressable>
    </View>;
  }

  const command = string(params.command);
  const reason = string(params.reason) || "Codex is waiting for approval.";
  const isPermission = request.method === "item/permissions/requestApproval";
  const isLegacy = request.method === "applyPatchApproval" || request.method === "execCommandApproval";
  const allowOnce: JsonValue = isPermission ? { permissions: params.permissions || {}, scope: "turn" } : { decision: isLegacy ? "approved" : "accept" };
  const allowSession: JsonValue = isPermission ? { permissions: params.permissions || {}, scope: "session" } : { decision: isLegacy ? "approved_for_session" : "acceptForSession" };
  const deny: JsonValue = isPermission ? { permissions: {}, scope: "turn" } : isLegacy ? { decision: { denied: { rejection: "Denied by user" } } } : { decision: "decline" };
  return <View style={styles.requestCard}>
    <Text style={styles.requestTitle}>Approval required</Text><Text style={styles.requestText}>{reason}</Text>
    {command && <Text style={styles.command}>{command}</Text>}
    <View style={styles.requestActions}><Pressable disabled={busy} style={styles.denyButton} onPress={() => void respond(deny)}><Text>Deny</Text></Pressable><Pressable disabled={busy} style={styles.allowButton} onPress={() => void respond(allowOnce)}><Text style={styles.primaryButtonText}>Allow once</Text></Pressable><Pressable disabled={busy} style={styles.allowButton} onPress={() => void respond(allowSession)}><Text style={styles.primaryButtonText}>Allow session</Text></Pressable></View>
  </View>;
}

function Chat({ thread, api, queue, requests, onClose, onChanged }: { thread: ThreadDto; api: BoardApi; queue: QueuedMessage[]; requests: PendingRemoteRequest[]; onClose: () => void; onChanged: () => void }) {
  const [loaded, setLoaded] = useState<JsonObject | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const lines = useMemo(() => conversation(loaded), [loaded]);
  const refresh = useCallback(() => void api.thread(thread.id).then(setLoaded).catch((error) => Alert.alert("Chat unavailable", error.message)), [api, thread.id]);
  useEffect(refresh, [refresh]);
  useEffect(() => api.subscribe((event) => { if (string(object(event.params).threadId) === thread.id) { refresh(); onChanged(); } }, () => {}), [api, refresh, thread.id, onChanged]);

  async function send() {
    const text = draft.trim(); if (!text || busy) return;
    setBusy(true);
    try { await api.send(thread.id, text); setDraft(""); onChanged(); }
    catch (error) { Alert.alert("Could not send", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  const turnId = activeTurnId(loaded);
  return <Modal animationType="slide"><SafeAreaView style={styles.page}>
    <View style={styles.header}><Pressable onPress={onClose}><Text style={styles.back}>‹ Board</Text></Pressable><View style={styles.headerCopy}><Text style={styles.headerTitle} numberOfLines={1}>{displayTitle(thread.name, thread.preview)}</Text><Text style={styles.headerMeta} numberOfLines={1}>{thread.cwd}</Text></View>{turnId && <Pressable onPress={() => void api.interrupt(thread.id, turnId)}><Text style={styles.stop}>Stop</Text></Pressable>}</View>
    <FlatList style={styles.chat} contentContainerStyle={styles.chatContent} data={lines} keyExtractor={(item) => item.id} ListEmptyComponent={<Text style={styles.empty}>No messages yet.</Text>} renderItem={({ item }) => <View style={[styles.bubble, styles[`bubble_${item.role}`]]}><Text style={[styles.bubbleText, item.role === "user" && styles.userText]}>{item.text || "…"}</Text></View>} ListFooterComponent={<>
      {queue.length > 0 && <View style={styles.queueBox}><Text style={styles.requestTitle}>{queue.length} queued</Text>{queue.map((message, index) => <View key={message.id} style={styles.queueRow}><Text style={styles.queueIndex}>{index + 1}</Text><Text style={styles.queueText}>{message.text}</Text><Pressable onPress={() => void api.removeQueued(thread.id, message.id).then(onChanged)}><Text style={styles.remove}>×</Text></Pressable></View>)}</View>}
      {requests.map((request) => <RequestCard key={JSON.stringify(request.requestId)} request={request} api={api} onDone={onChanged} />)}
    </>} />
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}><View style={styles.composer}><TextInput value={draft} onChangeText={setDraft} style={styles.composerInput} placeholder={turnId ? "Add to queue…" : "Message Codex…"} multiline /><Pressable disabled={!draft.trim() || busy} style={[styles.send, (!draft.trim() || busy) && styles.disabled]} onPress={() => void send()}><Text style={styles.primaryButtonText}>{turnId ? "Queue" : "Send"}</Text></Pressable></View></KeyboardAvoidingView>
  </SafeAreaView></Modal>;
}

function CategoryManager({ config, threads, api, onClose, onSaved }: { config: BoardConfig; threads: ThreadDto[]; api: BoardApi; onClose: () => void; onSaved: () => void }) {
  const [categories, setCategories] = useState(config.categories);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(next = categories) {
    setBusy(true);
    try { await api.updateBoard({ ...config, categories: next }); onSaved(); }
    catch (error) { Alert.alert("Could not save categories", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function add() {
    const name = draft.trim();
    if (!name || name.includes(" - ") || categories.includes(name)) return;
    const next = [...categories, name]; setCategories(next); setDraft(""); await save(next);
  }

  function rename(category: string) {
    setDraft(category);
    setEditing(category);
    Alert.alert("Rename category", "Enter the new name in the field, then use Rename.");
  }

  async function applyRename(current: string) {
    const nextName = draft.trim();
    if (!nextName || nextName.includes(" - ") || (nextName !== current && categories.includes(nextName))) return;
    setBusy(true);
    try {
      for (const thread of threads.filter((item) => categoryFromTitle(item.name) === current)) await api.rename(thread.id, taskName(nextName, displayTitle(thread.name, thread.preview)));
      const next = categories.map((item) => item === current ? nextName : item); setCategories(next); setDraft(""); setEditing(null); await api.updateBoard({ ...config, categories: next }); onSaved();
    } catch (error) { Alert.alert("Could not rename category", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <Modal animationType="slide"><SafeAreaView style={styles.page}><View style={styles.header}><Pressable onPress={onClose}><Text style={styles.back}>Done</Text></Pressable><Text style={styles.headerTitle}>Categories</Text><View style={styles.headerCopy} /></View><ScrollView contentContainerStyle={styles.manager}>
    <Text style={styles.subtitle}>Create, rename and reorder columns. Changes are shared with desktop immediately.</Text>
    <View style={styles.modeRow}><View style={styles.categoryCopy}><Text style={styles.cardTitle}>Approvals</Text><Text style={styles.headerMeta}>{config.approvalMode === "auto" ? "Commands and changes are approved automatically" : "Ask on desktop or mobile"}</Text></View><Pressable style={styles.denyButton} onPress={() => void api.updateBoard({ ...config, approvalMode: config.approvalMode === "auto" ? "ask" : "auto" }).then(onSaved)}><Text>{config.approvalMode === "auto" ? "Use Ask" : "Use Auto"}</Text></Pressable></View>
    <View style={styles.addRow}><TextInput style={[styles.smallInput, { flex: 1 }]} value={draft} onChangeText={setDraft} placeholder="Category name" /><Pressable disabled={busy} style={styles.allowButton} onPress={() => void add()}><Text style={styles.primaryButtonText}>Add</Text></Pressable></View>
    {categories.map((category, index) => { const count = threads.filter((thread) => categoryFromTitle(thread.name) === category).length; return <View key={category} style={styles.categoryRow}><View style={styles.categoryCopy}><Text style={styles.cardTitle}>{category}</Text><Text style={styles.headerMeta}>{count} tasks</Text></View><Pressable disabled={index === 0 || busy} onPress={() => { const next = [...categories]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; setCategories(next); void save(next); }}><Text style={styles.orderButton}>↑</Text></Pressable><Pressable disabled={index === categories.length - 1 || busy} onPress={() => { const next = [...categories]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; setCategories(next); void save(next); }}><Text style={styles.orderButton}>↓</Text></Pressable><Pressable disabled={busy} onPress={() => rename(category)}><Text style={styles.editButton}>Edit</Text></Pressable>{editing === category && <Pressable onPress={() => void applyRename(category)}><Text style={styles.editButton}>Rename</Text></Pressable>}{count === 0 && <Pressable disabled={busy} onPress={() => { const next = categories.filter((item) => item !== category); setCategories(next); void save(next); }}><Text style={styles.deleteButton}>Delete</Text></Pressable>}</View>; })}
  </ScrollView></SafeAreaView></Modal>;
}

function MoveDialog({ thread, categories, api, onClose, onMoved }: { thread: ThreadDto; categories: string[]; api: BoardApi; onClose: () => void; onMoved: () => void }) {
  const [busy, setBusy] = useState(false);
  async function move(category: string) {
    setBusy(true);
    try { await api.rename(thread.id, taskName(category, displayTitle(thread.name, thread.preview))); onMoved(); onClose(); }
    catch (error) { Alert.alert("Could not move task", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <Modal transparent animationType="fade"><View style={styles.modalBackdrop}><View style={styles.moveDialog}><Text style={styles.requestTitle}>Move task</Text><Text style={styles.requestText}>{displayTitle(thread.name, thread.preview)}</Text><ScrollView style={{ maxHeight: 420 }}>{categories.map((category) => <Pressable key={category} disabled={busy || category === categoryFromTitle(thread.name)} style={styles.moveOption} onPress={() => void move(category)}><Text style={category === categoryFromTitle(thread.name) ? styles.headerMeta : styles.cardTitle}>{category}</Text></Pressable>)}</ScrollView><Pressable style={styles.secondaryButton} onPress={onClose}><Text>Cancel</Text></Pressable></View></View></Modal>;
}

function Board({ credential, onDisconnect }: { credential: PairingCredential; onDisconnect: () => Promise<void> }) {
  const api = useMemo(() => new BoardApi(credential), [credential]);
  const [threads, setThreads] = useState<ThreadDto[]>([]);
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});
  const [requests, setRequests] = useState<PendingRemoteRequest[]>([]);
  const [selected, setSelected] = useState<ThreadDto | null>(null);
  const [managing, setManaging] = useState(false);
  const [moving, setMoving] = useState<ThreadDto | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const [nextThreads, nextConfig, nextQueues, nextRequests] = await Promise.all([api.threads(), api.board(), api.queues(), api.requests()]);
      setThreads(nextThreads); setConfig(nextConfig); setQueues(nextQueues); setRequests(nextRequests);
    } catch (error) { Alert.alert("PC unavailable", error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { void refresh(); return api.subscribe(() => void refresh(), setConnected); }, [api, refresh]);
  const discovered = [...new Set(threads.map((thread) => categoryFromTitle(thread.name)))];
  const categories = [...(config?.categories || []), ...discovered.filter((value) => !config?.categories.includes(value))];

  return <SafeAreaView style={styles.page}>
    <View style={styles.header}><View style={styles.headerCopy}><Text style={styles.headerTitle}>Codex Board</Text><Text style={styles.headerMeta}><Text style={{ color: connected ? "#43b77a" : "#d99a45" }}>●</Text> {connected ? "Live through Tailscale" : "Reconnecting…"}</Text></View><Pressable onPress={() => setManaging(true)}><Text style={styles.headerAction}>Categories</Text></Pressable><Pressable onPress={() => void onDisconnect()}><Text style={styles.headerAction}>Unpair</Text></Pressable></View>
    {loading ? <View style={styles.center}><ActivityIndicator /></View> : <ScrollView horizontal contentContainerStyle={styles.columns} showsHorizontalScrollIndicator={false}>{categories.map((category) => { const items = threads.filter((thread) => categoryFromTitle(thread.name) === category); return <View style={styles.column} key={category}><View style={styles.columnHeader}><Text style={styles.columnTitle}>{category}</Text><Text style={styles.count}>{items.length}</Text></View><ScrollView>{items.map((thread) => <View key={thread.id} style={[styles.card, isWorking(thread) && styles.workingCard]}><Pressable onPress={() => setSelected(thread)}><Text style={styles.cardTitle}>{displayTitle(thread.name, thread.preview)}</Text>{thread.preview && <Text style={styles.cardPreview} numberOfLines={3}>{thread.preview}</Text>}<Text style={[styles.cardStatus, isWorking(thread) && styles.workingText]}>{isWorking(thread) ? "● Codex is working" : "Open chat"}{queues[thread.id]?.length ? ` · ${queues[thread.id].length} queued` : ""}</Text></Pressable><Pressable style={styles.moveLink} onPress={() => setMoving(thread)}><Text style={styles.headerAction}>Move</Text></Pressable></View>)}</ScrollView></View>; })}</ScrollView>}
    {selected && <Chat thread={selected} api={api} queue={queues[selected.id] || []} requests={requests.filter((request) => requestThreadId(request) === selected.id)} onClose={() => setSelected(null)} onChanged={refresh} />}
    {managing && config && <CategoryManager config={config} threads={threads} api={api} onClose={() => setManaging(false)} onSaved={refresh} />}
    {moving && <MoveDialog thread={moving} categories={categories} api={api} onClose={() => setMoving(null)} onMoved={refresh} />}
  </SafeAreaView>;
}

function Root() {
  const [credential, setCredential] = useState<PairingCredential | null | undefined>(undefined);
  const dark = useColorScheme() === "dark";
  useEffect(() => { void loadCredential().then(setCredential); }, []);
  async function pair(next: PairingCredential) { await new BoardApi(next).health(); await saveCredential(next); setCredential(next); }
  async function disconnect() { await clearCredential(); setCredential(null); }
  if (credential === undefined) return <View style={styles.center}><ActivityIndicator /></View>;
  return <><StatusBar style={dark ? "light" : "dark"} />{credential ? <Board credential={credential} onDisconnect={disconnect} /> : <PairScreen onPair={pair} />}</>;
}

export default function App() { return <SafeAreaProvider><Root /></SafeAreaProvider>; }

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#f4f5f7" }, center: { flex: 1, alignItems: "center", justifyContent: "center" },
  pairPage: { flex: 1, padding: 28, justifyContent: "center", backgroundColor: "#f4f5f7" }, logo: { width: 52, height: 52, borderRadius: 14, backgroundColor: "#20242d", flexDirection: "row", alignItems: "flex-end", gap: 4, padding: 12, alignSelf: "center" }, logoBar: { flex: 1, borderRadius: 2, backgroundColor: "white" },
  title: { marginTop: 18, textAlign: "center", fontSize: 28, fontWeight: "700", color: "#202124" }, subtitle: { marginVertical: 12, textAlign: "center", color: "#6f7480", fontSize: 14, lineHeight: 21 }, or: { margin: 16, textAlign: "center", color: "#888", fontSize: 12 },
  primaryButton: { minHeight: 50, marginTop: 12, borderRadius: 12, backgroundColor: "#5869df", alignItems: "center", justifyContent: "center", paddingHorizontal: 18 }, compactButton: { minHeight: 40 }, primaryButtonText: { color: "white", fontWeight: "700" }, secondaryButton: { minHeight: 46, borderRadius: 12, backgroundColor: "white", alignItems: "center", justifyContent: "center", paddingHorizontal: 22 }, disabled: { opacity: 0.45 },
  input: { minHeight: 82, borderWidth: 1, borderColor: "#d7d9df", borderRadius: 12, padding: 12, backgroundColor: "white", textAlignVertical: "top" }, smallInput: { minHeight: 42, borderWidth: 1, borderColor: "#d7d9df", borderRadius: 9, padding: 10, backgroundColor: "white" },
  scanner: { flex: 1, backgroundColor: "black" }, scannerOverlay: { flex: 1, alignItems: "center", justifyContent: "space-between", padding: 28 }, scannerTitle: { color: "white", fontSize: 20, fontWeight: "700" }, scanFrame: { width: 250, height: 250, borderWidth: 3, borderColor: "white", borderRadius: 22 },
  header: { minHeight: 64, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: "#d9dbe1", backgroundColor: "white" }, headerCopy: { flex: 1 }, headerTitle: { color: "#202124", fontSize: 17, fontWeight: "700" }, headerMeta: { marginTop: 3, color: "#777d88", fontSize: 11 }, headerAction: { color: "#5869df", fontSize: 12, fontWeight: "600" }, back: { color: "#5869df", fontSize: 16 }, stop: { color: "#b54a3c", fontWeight: "700" },
  columns: { padding: 14, gap: 12 }, column: { width: 310, borderRadius: 14, backgroundColor: "#e9ebef", padding: 10 }, columnHeader: { height: 42, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4 }, columnTitle: { color: "#31343b", fontSize: 13, fontWeight: "700" }, count: { color: "#777d88", backgroundColor: "white", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, fontSize: 11 },
  card: { marginBottom: 9, padding: 14, borderRadius: 11, borderWidth: 1, borderColor: "#dddfe5", backgroundColor: "white" }, workingCard: { borderColor: "#7d8aeb" }, cardTitle: { color: "#202124", fontSize: 14, fontWeight: "600" }, cardPreview: { marginTop: 7, color: "#747985", fontSize: 12, lineHeight: 17 }, cardStatus: { marginTop: 11, color: "#5869df", fontSize: 10, fontWeight: "600" }, workingText: { color: "#5869df" }, empty: { textAlign: "center", color: "#777", marginTop: 50 },
  chat: { flex: 1 }, chatContent: { padding: 16, gap: 10 }, bubble: { maxWidth: "88%", borderRadius: 13, paddingHorizontal: 13, paddingVertical: 10 }, bubble_user: { alignSelf: "flex-end", backgroundColor: "#5869df", borderBottomRightRadius: 4 }, bubble_assistant: { alignSelf: "flex-start", backgroundColor: "white", borderBottomLeftRadius: 4 }, bubble_activity: { alignSelf: "stretch", maxWidth: "100%", backgroundColor: "#e7e9ee" }, bubbleText: { color: "#272a31", fontSize: 14, lineHeight: 20 }, userText: { color: "white" },
  composer: { flexDirection: "row", gap: 9, alignItems: "flex-end", padding: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: "#d9dbe1", backgroundColor: "white" }, composerInput: { flex: 1, maxHeight: 120, minHeight: 44, padding: 11, borderWidth: 1, borderColor: "#d9dbe1", borderRadius: 12 }, send: { minHeight: 44, minWidth: 64, paddingHorizontal: 14, borderRadius: 10, backgroundColor: "#5869df", alignItems: "center", justifyContent: "center" },
  queueBox: { marginTop: 10, padding: 12, borderRadius: 10, backgroundColor: "#eef0ff" }, queueRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: "#ccd1ee" }, queueIndex: { color: "#5869df", fontWeight: "700" }, queueText: { flex: 1, fontSize: 12, lineHeight: 17 }, remove: { fontSize: 20, color: "#777" },
  requestCard: { marginTop: 12, padding: 14, borderRadius: 11, borderWidth: 1, borderColor: "#8792e8", backgroundColor: "white" }, requestTitle: { fontSize: 13, fontWeight: "700" }, requestText: { marginTop: 6, color: "#666", fontSize: 12, lineHeight: 17 }, command: { marginTop: 8, padding: 9, borderRadius: 7, backgroundColor: "#22252b", color: "white", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 11 }, requestActions: { marginTop: 12, flexDirection: "row", flexWrap: "wrap", gap: 7 }, denyButton: { minHeight: 38, paddingHorizontal: 12, borderRadius: 8, backgroundColor: "#e7e8eb", alignItems: "center", justifyContent: "center" }, allowButton: { minHeight: 38, paddingHorizontal: 12, borderRadius: 8, backgroundColor: "#5869df", alignItems: "center", justifyContent: "center" }, question: { marginTop: 10 }, questionText: { marginBottom: 7, fontSize: 12, fontWeight: "600" }, option: { marginTop: 6, padding: 10, borderWidth: 1, borderColor: "#dddfe5", borderRadius: 8 }, optionSelected: { borderColor: "#5869df", backgroundColor: "#eef0ff" }, optionDescription: { marginTop: 3, color: "#777", fontSize: 10 },
  manager: { padding: 16 }, addRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16 }, categoryRow: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: "#d9dbe1" }, categoryCopy: { flex: 1 }, orderButton: { fontSize: 21, color: "#5869df" }, editButton: { color: "#5869df", fontSize: 12, fontWeight: "600" }, deleteButton: { color: "#b54a3c", fontSize: 12, fontWeight: "600" },
  modeRow: { marginBottom: 16, padding: 12, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 10, backgroundColor: "white" }, moveLink: { alignSelf: "flex-end", marginTop: 8, padding: 4 }, modalBackdrop: { flex: 1, padding: 24, justifyContent: "center", backgroundColor: "rgba(0,0,0,.4)" }, moveDialog: { padding: 18, borderRadius: 14, backgroundColor: "#f4f5f7" }, moveOption: { minHeight: 46, justifyContent: "center", paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: "#d9dbe1" },
});
