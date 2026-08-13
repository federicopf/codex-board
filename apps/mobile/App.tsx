import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform,
  Pressable, ScrollView, StyleSheet, Text, TextInput, useColorScheme, View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import Markdown from "react-native-markdown-display";
import {
  categoryFromTitle, displayTitle, parsePairingPayload,
  type Automation, type BoardConfig, type CreateAutomationInput, type JsonValue, type PairingCredential,
  type PendingRemoteRequest, type QueuedMessage, type ThreadDto,
} from "@codex-board/protocol";
import { BoardApi } from "./src/api";
import { clearCredential, loadCredential, saveCredential } from "./src/connection";

type JsonObject = Record<string, JsonValue>;
const object = (value: JsonValue | undefined): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const string = (value: JsonValue | undefined): string => typeof value === "string" ? value : "";
const requestThreadId = (request: PendingRemoteRequest) => string(object(request.params).threadId);

interface ChatLine { id: string; role: "user" | "assistant" | "activity"; text: string; }

const threadCache = new Map<string, JsonObject>();

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

function projectLabel(cwd: string | null): string {
  const parts = (cwd || "Local project").split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "Local project";
}

const ALL_PROJECTS = "__all_projects__";
const projectKey = (cwd: string | null): string => (cwd || "").trim().replace(/[\\/]+$/, "").toLocaleLowerCase() || "__local__";

function taskName(category: string, title: string): string {
  return category === "Uncategorized" ? title : `${category} - ${title}`;
}

function automationDescription(automation: Automation, threads: ThreadDto[]): string {
  const action = automation.action;
  if (action.kind === "recurringMessage") {
    const thread = threads.find((item) => item.id === action.threadId);
    return `Every ${action.everyMinutes} min · ${displayTitle(thread?.name || null, thread?.preview || null)}`;
  }
  return `${action.fromCategory} → ${action.toCategory} after ${action.afterMinutes} min`;
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
    <View style={styles.pairHero}><View style={styles.logo}><View style={[styles.logoBar, { height: 14 }]} /><View style={[styles.logoBar, { height: 27 }]} /><View style={[styles.logoBar, { height: 20 }]} /></View>
      <Text style={styles.pairEyebrow}>YOUR CODEX, EVERYWHERE</Text><Text style={styles.title}>Codex Board</Text>
      <Text style={styles.subtitle}>Your projects, conversations and approvals—securely connected to the PC through Tailscale.</Text>
    </View>
    <View style={styles.pairCard}><Pressable style={styles.primaryButton} onPress={async () => {
        if (!permission?.granted) { const result = await requestPermission(); if (!result.granted) return; }
        setScanning(true);
      }}><Text style={styles.primaryButtonText}>Scan pairing QR</Text></Pressable>
      <Text style={styles.or}>OR CONNECT MANUALLY</Text>
      <TextInput style={styles.input} value={value} onChangeText={setValue} multiline autoCapitalize="none" autoCorrect={false} placeholder="Paste pairing URL or JSON" />
      <Pressable disabled={busy || !value.trim()} style={[styles.primaryButton, styles.connectButton, (busy || !value.trim()) && styles.disabled]} onPress={() => void pair(value)}>
        {busy ? <ActivityIndicator color="white" /> : <Text style={styles.primaryButtonText}>Connect securely</Text>}
      </Pressable>
    </View><Text style={styles.pairFootnote}>The connection stays private inside your Tailscale network.</Text>
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

function Chat({ thread, api, queue, requests, eventRevision, onClose, onChanged }: { thread: ThreadDto; api: BoardApi; queue: QueuedMessage[]; requests: PendingRemoteRequest[]; eventRevision: number; onClose: () => void; onChanged: () => void }) {
  const [loaded, setLoaded] = useState<JsonObject | null>(() => threadCache.get(thread.id) || null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const lines = useMemo(() => conversation(loaded), [loaded]);
  const timeline = useMemo(() => [...lines].reverse(), [lines]);
  const refresh = useCallback(() => void api.thread(thread.id).then((next) => { threadCache.set(thread.id, next); setLoaded(next); }).catch((error) => Alert.alert("Chat unavailable", error.message)), [api, thread.id]);
  useEffect(refresh, [refresh]);
  useEffect(() => { if (eventRevision > 0) refresh(); }, [eventRevision, refresh]);

  async function send() {
    const text = draft.trim(); if (!text || busy) return;
    setBusy(true);
    try { await api.send(thread.id, text); setDraft(""); onChanged(); }
    catch (error) { Alert.alert("Could not send", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  const turnId = activeTurnId(loaded);
  return <Modal animationType="slide"><SafeAreaView style={styles.page}>
    <View style={styles.header}><Pressable style={styles.chatBackButton} onPress={onClose}><Text style={styles.back}>‹</Text></Pressable><View style={styles.headerCopy}><View style={styles.chatTitleRow}><Text style={styles.headerTitle} numberOfLines={1}>{displayTitle(thread.name, thread.preview)}</Text><View style={[styles.chatState, turnId && styles.chatStateLive]}><Text style={[styles.chatStateText, turnId && styles.chatStateTextLive]}>{turnId ? "Working" : "Ready"}</Text></View></View><Text style={styles.headerMeta} numberOfLines={1}>{projectLabel(thread.cwd)}</Text></View>{turnId && <Pressable style={styles.stopButton} onPress={() => void api.interrupt(thread.id, turnId)}><Text style={styles.stop}>Stop</Text></Pressable>}</View>
    <FlatList inverted style={styles.chat} contentContainerStyle={styles.chatContent} data={timeline} keyExtractor={(item) => item.id} maintainVisibleContentPosition={{ minIndexForVisible: 0 }} ListEmptyComponent={<Text style={styles.empty}>No messages yet.</Text>} renderItem={({ item }) => <View style={[styles.bubble, styles[`bubble_${item.role}`]]}>{item.role !== "user" && <Text style={styles.bubbleLabel}>{item.role === "assistant" ? "CODEX" : "ACTIVITY"}</Text>}{item.role === "assistant" ? <Markdown style={markdownStyles}>{item.text || "…"}</Markdown> : <Text style={[styles.bubbleText, item.role === "user" && styles.userText]}>{item.text || "…"}</Text>}</View>} ListHeaderComponent={<>
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

  return <Modal animationType="slide"><SafeAreaView style={styles.page}><View style={styles.header}><Pressable style={styles.chatBackButton} onPress={onClose}><Text style={styles.managerDone}>Done</Text></Pressable><View style={styles.headerCopy}><Text style={styles.headerTitle}>Manage categories</Text><Text style={styles.headerMeta}>Synced with desktop in real time</Text></View></View><ScrollView contentContainerStyle={styles.manager}>
    <View style={styles.managerIntro}><Text style={styles.overviewEyebrow}>BOARD STRUCTURE</Text><Text style={styles.managerTitle}>Make the board yours</Text><Text style={styles.managerSubtitle}>Create, rename and reorder columns. Categories are driven by your prefixes.</Text></View>
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
  const current = categoryFromTitle(thread.name);
  return <Modal transparent animationType="fade"><View style={styles.modalBackdrop}><View style={styles.moveDialog}><View style={styles.sheetHandle} /><Text style={styles.moveEyebrow}>MOVE TASK</Text><Text style={styles.moveTitle} numberOfLines={2}>{displayTitle(thread.name, thread.preview)}</Text><Text style={styles.moveSubtitle}>Choose the next board stage.</Text><ScrollView style={styles.moveOptions}>{categories.map((category) => { const selected = category === current; return <Pressable key={category} disabled={busy || selected} style={[styles.moveOption, selected && styles.moveOptionSelected]} onPress={() => void move(category)}><View style={[styles.categoryDot, selected && styles.categoryDotSelected]} /><Text style={[styles.moveOptionText, selected && styles.moveOptionTextSelected]}>{category}</Text>{selected ? <Text style={styles.currentLabel}>CURRENT</Text> : <Text style={styles.moveChevron}>›</Text>}</Pressable>; })}</ScrollView><Pressable style={styles.moveCancel} onPress={onClose}><Text style={styles.moveCancelText}>Cancel</Text></Pressable></View></View></Modal>;
}

function ChoiceModal({ title, options, selected, onSelect, onClose }: { title: string; options: { key: string; label: string; meta?: string }[]; selected: string; onSelect: (key: string) => void; onClose: () => void }) {
  return <Modal transparent animationType="fade"><View style={styles.modalBackdrop}><View style={styles.choiceDialog}><View style={styles.sheetHandle} /><Text style={styles.moveTitle}>{title}</Text><ScrollView style={styles.choiceList}>{options.map((option) => <Pressable key={option.key} style={[styles.choiceRow, option.key === selected && styles.choiceRowSelected]} onPress={() => { onSelect(option.key); onClose(); }}><View><Text style={styles.choiceLabel}>{option.label}</Text>{option.meta && <Text style={styles.headerMeta}>{option.meta}</Text>}</View>{option.key === selected && <Text style={styles.choiceCheck}>✓</Text>}</Pressable>)}</ScrollView><Pressable style={styles.moveCancel} onPress={onClose}><Text style={styles.moveCancelText}>Cancel</Text></Pressable></View></View></Modal>;
}

function AutomationManager({ api, automations, threads, categories, onClose, onChanged }: { api: BoardApi; automations: Automation[]; threads: ThreadDto[]; categories: string[]; onClose: () => void; onChanged: () => void }) {
  const [kind, setKind] = useState<"recurringMessage" | "categoryPipeline">("recurringMessage");
  const [name, setName] = useState("");
  const [threadId, setThreadId] = useState(threads[0]?.id || "");
  const [prompt, setPrompt] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [fromCategory, setFromCategory] = useState(categories[0] || "");
  const [toCategory, setToCategory] = useState(categories[1] || categories[0] || "");
  const [busy, setBusy] = useState(false);
  async function create() {
    const interval = Number.parseInt(minutes, 10);
    if (!name.trim() || !Number.isFinite(interval) || interval < 1) return;
    const input: CreateAutomationInput = kind === "recurringMessage"
      ? { name: name.trim(), action: { kind, threadId, prompt: prompt.trim(), everyMinutes: interval, startInMinutes: interval } }
      : { name: name.trim(), action: { kind, fromCategory, toCategory, afterMinutes: interval } };
    setBusy(true);
    try { await api.createAutomation(input); setName(""); setPrompt(""); onChanged(); }
    catch (error) { Alert.alert("Could not create automation", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const valid = name.trim() && Number(minutes) >= 1 && (kind === "recurringMessage" ? threadId && prompt.trim() : fromCategory && toCategory && fromCategory !== toCategory);
  return <Modal animationType="slide"><SafeAreaView style={styles.page}><View style={styles.header}><Pressable style={styles.chatBackButton} onPress={onClose}><Text style={styles.managerDone}>Done</Text></Pressable><View style={styles.headerCopy}><Text style={styles.headerTitle}>Automations</Text><Text style={styles.headerMeta}>Runs on your PC, even when mobile is closed</Text></View></View><ScrollView contentContainerStyle={styles.manager}>
    <View style={styles.managerIntro}><Text style={styles.overviewEyebrow}>WORKFLOWS</Text><Text style={styles.managerTitle}>Put the board on autopilot</Text><Text style={styles.managerSubtitle}>Schedule recurring prompts or move cards through your pipeline after a delay.</Text></View>
    <View style={styles.automationComposer}><View style={styles.segmented}><Pressable style={[styles.segment, kind === "recurringMessage" && styles.segmentActive]} onPress={() => setKind("recurringMessage")}><Text style={[styles.segmentText, kind === "recurringMessage" && styles.segmentTextActive]}>Recurring task</Text></Pressable><Pressable style={[styles.segment, kind === "categoryPipeline" && styles.segmentActive]} onPress={() => setKind("categoryPipeline")}><Text style={[styles.segmentText, kind === "categoryPipeline" && styles.segmentTextActive]}>Pipeline move</Text></Pressable></View>
      <TextInput style={styles.smallInput} value={name} onChangeText={setName} placeholder="Automation name" />
      {kind === "recurringMessage" ? <><Text style={styles.fieldLabel}>TASK</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.miniChoices}>{threads.map((thread) => <Pressable key={thread.id} style={[styles.miniChoice, thread.id === threadId && styles.miniChoiceActive]} onPress={() => setThreadId(thread.id)}><Text numberOfLines={1} style={[styles.miniChoiceText, thread.id === threadId && styles.miniChoiceTextActive]}>{displayTitle(thread.name, thread.preview)}</Text></Pressable>)}</ScrollView><TextInput style={[styles.smallInput, styles.promptInput]} value={prompt} onChangeText={setPrompt} multiline placeholder="What should Codex do?" /><Text style={styles.fieldLabel}>REPEAT EVERY (MINUTES)</Text></> : <><Text style={styles.fieldLabel}>FROM CATEGORY</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.miniChoices}>{categories.map((category) => <Pressable key={category} style={[styles.miniChoice, category === fromCategory && styles.miniChoiceActive]} onPress={() => setFromCategory(category)}><Text style={[styles.miniChoiceText, category === fromCategory && styles.miniChoiceTextActive]}>{category}</Text></Pressable>)}</ScrollView><Text style={styles.fieldLabel}>TO CATEGORY</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.miniChoices}>{categories.map((category) => <Pressable key={category} style={[styles.miniChoice, category === toCategory && styles.miniChoiceActive]} onPress={() => setToCategory(category)}><Text style={[styles.miniChoiceText, category === toCategory && styles.miniChoiceTextActive]}>{category}</Text></Pressable>)}</ScrollView><Text style={styles.fieldLabel}>MOVE AFTER (MINUTES)</Text></>}
      <TextInput style={styles.smallInput} value={minutes} onChangeText={setMinutes} keyboardType="number-pad" /><Pressable disabled={!valid || busy} style={[styles.primaryButton, (!valid || busy) && styles.disabled]} onPress={() => void create()}>{busy ? <ActivityIndicator color="white" /> : <Text style={styles.primaryButtonText}>Create automation</Text>}</Pressable>
    </View>
    <Text style={styles.automationSectionTitle}>{automations.length} AUTOMATIONS</Text>{automations.map((automation) => <View key={automation.id} style={styles.automationCard}><View style={styles.automationCardTop}><View style={styles.automationIcon}><Text>{automation.action.kind === "recurringMessage" ? "↻" : "→"}</Text></View><View style={styles.categoryCopy}><Text style={styles.automationName}>{automation.name}</Text><Text style={styles.automationDescription}>{automationDescription(automation, threads)}</Text>{automation.lastError && <Text style={styles.automationError}>{automation.lastError}</Text>}</View><Pressable style={[styles.toggle, automation.enabled && styles.toggleOn]} onPress={() => void api.setAutomationEnabled(automation.id, !automation.enabled).then(onChanged)}><View style={[styles.toggleKnob, automation.enabled && styles.toggleKnobOn]} /></Pressable></View><Pressable onPress={() => Alert.alert("Delete automation?", automation.name, [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => void api.deleteAutomation(automation.id).then(onChanged) }])}><Text style={styles.deleteAutomation}>Delete</Text></Pressable></View>)}
  </ScrollView></SafeAreaView></Modal>;
}

function Board({ credential, onDisconnect }: { credential: PairingCredential; onDisconnect: () => Promise<void> }) {
  const api = useMemo(() => new BoardApi(credential), [credential]);
  const [threads, setThreads] = useState<ThreadDto[]>([]);
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});
  const [requests, setRequests] = useState<PendingRemoteRequest[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [selected, setSelected] = useState<ThreadDto | null>(null);
  const [managing, setManaging] = useState(false);
  const [moving, setMoving] = useState<ThreadDto | null>(null);
  const [automating, setAutomating] = useState(false);
  const [choosingProject, setChoosingProject] = useState(false);
  const [selectedProject, setSelectedProject] = useState(ALL_PROJECTS);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [eventRevision, setEventRevision] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [nextThreads, nextConfig, nextQueues, nextRequests, nextAutomations] = await Promise.all([api.threads(), api.board(), api.queues(), api.requests(), api.automations().catch(() => [])]);
      setThreads(nextThreads); setConfig(nextConfig); setQueues(nextQueues); setRequests(nextRequests); setAutomations(nextAutomations);
    } catch (error) { Alert.alert("PC unavailable", error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  }, [api]);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      setEventRevision((value) => value + 1);
      void refresh();
    }, 250);
  }, [refresh]);
  useEffect(() => {
    void refresh();
    const unsubscribe = api.subscribe(scheduleRefresh, setConnected);
    return () => {
      unsubscribe();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [api, refresh, scheduleRefresh]);
  const discovered = [...new Set(threads.map((thread) => categoryFromTitle(thread.name)))];
  const categories = [...(config?.categories || []), ...discovered.filter((value) => !config?.categories.includes(value))];
  const projects = [...new Map(threads.map((thread) => [projectKey(thread.cwd), { key: projectKey(thread.cwd), label: projectLabel(thread.cwd), cwd: thread.cwd || "Local project" }])).values()];
  useEffect(() => { if (selectedProject !== ALL_PROJECTS && !projects.some((project) => project.key === selectedProject)) setSelectedProject(ALL_PROJECTS); }, [selectedProject, projects.map((project) => project.key).join("\u0000")]);
  useEffect(() => {
    if (categories.length > 0 && (!activeCategory || !categories.includes(activeCategory))) setActiveCategory(categories[0]);
  }, [activeCategory, categories.join("\u0000")]);
  const visibleCategory = activeCategory || categories[0];
  const projectThreads = selectedProject === ALL_PROJECTS ? threads : threads.filter((thread) => projectKey(thread.cwd) === selectedProject);
  const visibleThreads = projectThreads.filter((thread) => categoryFromTitle(thread.name) === visibleCategory);
  const workingCount = projectThreads.filter(isWorking).length;
  const selectedProjectLabel = selectedProject === ALL_PROJECTS ? "All projects" : projects.find((project) => project.key === selectedProject)?.label || "Project";

  return <SafeAreaView style={styles.page}>
    <View style={styles.mobileHeader}><View style={styles.mobileBrand}><View style={styles.mobileLogo}><View style={[styles.logoBar, { height: 9 }]} /><View style={[styles.logoBar, { height: 18 }]} /><View style={[styles.logoBar, { height: 13 }]} /></View><View><Text style={styles.mobileTitle}>Codex Board</Text><Text style={styles.connectionText}><Text style={{ color: connected ? "#2CB67D" : "#E7A33E" }}>●</Text> {connected ? "Live through Tailscale" : "Reconnecting…"}</Text></View></View><View style={styles.headerActions}><Pressable style={styles.iconAction} onPress={() => setAutomating(true)}><Text style={styles.automationActionText}>⚡</Text></Pressable><Pressable style={styles.iconAction} onPress={() => setManaging(true)}><Text style={styles.iconActionText}>☰</Text></Pressable><Pressable style={styles.avatarAction} onPress={() => void onDisconnect()}><Text style={styles.avatarText}>CB</Text></Pressable></View></View>
    <View style={styles.mobileOverview}><View><Text style={styles.overviewEyebrow}>YOUR WORKSPACE</Text><Text style={styles.overviewTitle}>{projectThreads.length} active threads</Text></View><View style={styles.liveMetric}><Text style={styles.liveMetricNumber}>{workingCount}</Text><Text style={styles.liveMetricLabel}>working</Text></View></View>
    <Pressable style={styles.projectFilter} onPress={() => setChoosingProject(true)}><View><Text style={styles.projectFilterLabel}>PROJECT</Text><Text style={styles.projectFilterValue}>{selectedProjectLabel}</Text></View><Text style={styles.projectFilterChevron}>⌄</Text></Pressable>
    <ScrollView horizontal style={styles.categoryTabsScroll} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryTabs}>{categories.map((category) => { const count = projectThreads.filter((thread) => categoryFromTitle(thread.name) === category).length; const active = category === visibleCategory; return <Pressable key={category} style={[styles.categoryTab, active && styles.categoryTabActive]} onPress={() => setActiveCategory(category)}><Text style={[styles.categoryTabText, active && styles.categoryTabTextActive]}>{category}</Text><Text style={[styles.categoryTabCount, active && styles.categoryTabCountActive]}>{count}</Text></Pressable>; })}</ScrollView>
    {loading ? <View style={styles.center}><ActivityIndicator color="#6266EA" /></View> : <FlatList style={styles.taskList} contentContainerStyle={styles.taskListContent} data={visibleThreads} keyExtractor={(thread) => thread.id} ListHeaderComponent={<View style={styles.listHeading}><Text style={styles.listTitle}>{visibleCategory}</Text><Text style={styles.listCount}>{visibleThreads.length} {visibleThreads.length === 1 ? "task" : "tasks"}</Text></View>} ListEmptyComponent={<View style={styles.emptyColumn}><Text style={styles.emptyIcon}>◇</Text><Text style={styles.emptyTitle}>No threads here</Text><Text style={styles.emptyText}>Move a thread into this category from another column.</Text></View>} renderItem={({ item: thread }) => <View style={[styles.card, isWorking(thread) && styles.workingCard]}><Pressable onPress={() => setSelected(thread)}><View style={styles.cardTop}><Text style={styles.projectPill}>{projectLabel(thread.cwd)}</Text>{isWorking(thread) && <View style={styles.workingPill}><Text style={styles.workingPillText}>● Working</Text></View>}</View><Text style={styles.cardTitle}>{displayTitle(thread.name, thread.preview)}</Text>{thread.preview && <Text style={styles.cardPreview} numberOfLines={3}>{thread.preview}</Text>}<View style={styles.cardBottom}><Text style={[styles.cardStatus, isWorking(thread) && styles.workingText]}>{queues[thread.id]?.length ? `${queues[thread.id].length} queued` : isWorking(thread) ? "Codex is working" : "Open conversation"}</Text><Text style={styles.openArrow}>→</Text></View></Pressable><Pressable style={styles.moveLink} onPress={() => setMoving(thread)}><Text style={styles.moveLinkText}>Move</Text></Pressable></View>} />}
    {selected && <Chat thread={selected} api={api} queue={queues[selected.id] || []} requests={requests.filter((request) => requestThreadId(request) === selected.id)} eventRevision={eventRevision} onClose={() => setSelected(null)} onChanged={refresh} />}
    {managing && config && <CategoryManager config={config} threads={threads} api={api} onClose={() => setManaging(false)} onSaved={refresh} />}
    {automating && <AutomationManager api={api} automations={automations} threads={threads} categories={categories} onClose={() => setAutomating(false)} onChanged={refresh} />}
    {choosingProject && <ChoiceModal title="Filter by project" options={[{ key: ALL_PROJECTS, label: "All projects", meta: `${threads.length} tasks` }, ...projects.map((project) => ({ key: project.key, label: project.label, meta: project.cwd }))]} selected={selectedProject} onSelect={setSelectedProject} onClose={() => setChoosingProject(false)} />}
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
  page: { flex: 1, backgroundColor: "#F4F5F9" }, center: { flex: 1, alignItems: "center", justifyContent: "center" },
  pairPage: { flex: 1, padding: 24, justifyContent: "center", backgroundColor: "#F4F5F9" }, pairHero: { alignItems: "center", marginBottom: 22 }, pairCard: { padding: 18, borderWidth: 1, borderColor: "#E1E3EB", borderRadius: 20, backgroundColor: "white", shadowColor: "#171923", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.07, shadowRadius: 20, elevation: 3 }, logo: { width: 58, height: 58, borderRadius: 17, backgroundColor: "#1B1E2B", flexDirection: "row", alignItems: "flex-end", gap: 4, padding: 13, alignSelf: "center" }, logoBar: { flex: 1, borderRadius: 2, backgroundColor: "white" },
  pairEyebrow: { marginTop: 19, color: "#6266EA", fontSize: 9, fontWeight: "800", letterSpacing: 1.4 }, pairFootnote: { marginTop: 16, textAlign: "center", color: "#8A8F9C", fontSize: 10, lineHeight: 15 }, connectButton: { marginTop: 10 },
  title: { marginTop: 20, textAlign: "center", fontSize: 30, fontWeight: "800", letterSpacing: -1, color: "#171923" }, subtitle: { marginVertical: 12, textAlign: "center", color: "#747987", fontSize: 14, lineHeight: 21 }, or: { margin: 16, textAlign: "center", color: "#969BA7", fontSize: 11, fontWeight: "600" },
  primaryButton: { minHeight: 52, marginTop: 12, borderRadius: 14, backgroundColor: "#6266EA", alignItems: "center", justifyContent: "center", paddingHorizontal: 18 }, compactButton: { minHeight: 42 }, primaryButtonText: { color: "white", fontWeight: "700" }, secondaryButton: { minHeight: 46, borderRadius: 12, backgroundColor: "white", alignItems: "center", justifyContent: "center", paddingHorizontal: 22 }, disabled: { opacity: 0.45 },
  input: { minHeight: 82, borderWidth: 1, borderColor: "#d7d9df", borderRadius: 12, padding: 12, backgroundColor: "white", textAlignVertical: "top" }, smallInput: { minHeight: 42, borderWidth: 1, borderColor: "#d7d9df", borderRadius: 9, padding: 10, backgroundColor: "white" },
  scanner: { flex: 1, backgroundColor: "black" }, scannerOverlay: { flex: 1, alignItems: "center", justifyContent: "space-between", padding: 28 }, scannerTitle: { color: "white", fontSize: 20, fontWeight: "700" }, scanFrame: { width: 250, height: 250, borderWidth: 3, borderColor: "white", borderRadius: 22 },
  header: { minHeight: 70, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: "#DFE1E8", backgroundColor: "white" }, headerCopy: { flex: 1 }, headerTitle: { maxWidth: "76%", color: "#171923", fontSize: 17, fontWeight: "800", letterSpacing: -0.35 }, headerMeta: { marginTop: 3, color: "#858A96", fontSize: 10 }, headerAction: { color: "#6266EA", fontSize: 12, fontWeight: "700" }, back: { color: "#6266EA", fontSize: 25, lineHeight: 27 }, stop: { color: "#B6473A", fontSize: 11, fontWeight: "800" },
  columns: { padding: 14, gap: 12 }, column: { width: 310, borderRadius: 14, backgroundColor: "#e9ebef", padding: 10 }, columnHeader: { height: 42, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4 }, columnTitle: { color: "#31343b", fontSize: 13, fontWeight: "700" }, count: { color: "#777d88", backgroundColor: "white", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, fontSize: 11 },
  card: { marginBottom: 13, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: "#E2E4EC", backgroundColor: "white", shadowColor: "#171923", shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.06, shadowRadius: 14, elevation: 2 }, workingCard: { borderColor: "#9295F2", borderLeftWidth: 4 }, cardTitle: { color: "#171923", fontSize: 17, lineHeight: 22, fontWeight: "700", letterSpacing: -0.3 }, cardPreview: { marginTop: 8, color: "#747987", fontSize: 13, lineHeight: 19 }, cardStatus: { color: "#6266EA", fontSize: 11, fontWeight: "700" }, workingText: { color: "#6266EA" }, empty: { textAlign: "center", color: "#777", marginTop: 50 },
  chat: { flex: 1 }, chatContent: { padding: 16, paddingBottom: 22, gap: 11 }, bubble: { maxWidth: "90%", borderRadius: 17, paddingHorizontal: 15, paddingVertical: 12 }, bubble_user: { alignSelf: "flex-end", backgroundColor: "#6266EA", borderBottomRightRadius: 5 }, bubble_assistant: { alignSelf: "flex-start", backgroundColor: "white", borderBottomLeftRadius: 5, borderWidth: 1, borderColor: "#E4E6ED" }, bubble_activity: { alignSelf: "stretch", maxWidth: "100%", backgroundColor: "#ECEEF4", borderRadius: 12 }, bubbleLabel: { marginBottom: 7, color: "#858A96", fontSize: 8, fontWeight: "800", letterSpacing: 1 }, bubbleText: { color: "#252832", fontSize: 14, lineHeight: 21 }, userText: { color: "white" },
  composer: { flexDirection: "row", gap: 9, alignItems: "flex-end", padding: 11, borderTopWidth: StyleSheet.hairlineWidth, borderColor: "#DFE1E8", backgroundColor: "white" }, composerInput: { flex: 1, maxHeight: 120, minHeight: 46, padding: 12, borderWidth: 1, borderColor: "#D9DCE5", borderRadius: 14, backgroundColor: "#F8F8FA" }, send: { minHeight: 46, minWidth: 68, paddingHorizontal: 14, borderRadius: 12, backgroundColor: "#6266EA", alignItems: "center", justifyContent: "center" },
  queueBox: { marginTop: 10, padding: 12, borderRadius: 10, backgroundColor: "#eef0ff" }, queueRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: "#ccd1ee" }, queueIndex: { color: "#5869df", fontWeight: "700" }, queueText: { flex: 1, fontSize: 12, lineHeight: 17 }, remove: { fontSize: 20, color: "#777" },
  requestCard: { marginTop: 12, padding: 14, borderRadius: 11, borderWidth: 1, borderColor: "#8792e8", backgroundColor: "white" }, requestTitle: { fontSize: 13, fontWeight: "700" }, requestText: { marginTop: 6, color: "#666", fontSize: 12, lineHeight: 17 }, command: { marginTop: 8, padding: 9, borderRadius: 7, backgroundColor: "#22252b", color: "white", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 11 }, requestActions: { marginTop: 12, flexDirection: "row", flexWrap: "wrap", gap: 7 }, denyButton: { minHeight: 38, paddingHorizontal: 12, borderRadius: 8, backgroundColor: "#e7e8eb", alignItems: "center", justifyContent: "center" }, allowButton: { minHeight: 38, paddingHorizontal: 12, borderRadius: 8, backgroundColor: "#5869df", alignItems: "center", justifyContent: "center" }, question: { marginTop: 10 }, questionText: { marginBottom: 7, fontSize: 12, fontWeight: "600" }, option: { marginTop: 6, padding: 10, borderWidth: 1, borderColor: "#dddfe5", borderRadius: 8 }, optionSelected: { borderColor: "#5869df", backgroundColor: "#eef0ff" }, optionDescription: { marginTop: 3, color: "#777", fontSize: 10 },
  manager: { padding: 16, paddingBottom: 30 }, managerDone: { color: "#6266EA", fontSize: 11, fontWeight: "800" }, managerIntro: { padding: 6, marginBottom: 16 }, managerTitle: { marginTop: 5, color: "#171923", fontSize: 25, fontWeight: "800", letterSpacing: -0.8 }, managerSubtitle: { marginTop: 7, color: "#7B808D", fontSize: 12, lineHeight: 18 }, addRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16 }, categoryRow: { minHeight: 66, marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 13, paddingVertical: 10, borderWidth: 1, borderColor: "#E2E4EC", borderRadius: 13, backgroundColor: "white" }, categoryCopy: { flex: 1 }, orderButton: { fontSize: 21, color: "#6266EA" }, editButton: { color: "#6266EA", fontSize: 11, fontWeight: "700" }, deleteButton: { color: "#B54A3C", fontSize: 11, fontWeight: "700" },
  modeRow: { marginBottom: 16, padding: 12, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 10, backgroundColor: "white" }, moveLink: { alignSelf: "flex-end", marginTop: 8, padding: 4 }, modalBackdrop: { flex: 1, padding: 16, justifyContent: "flex-end", backgroundColor: "rgba(18,20,27,.48)" }, moveDialog: { maxHeight: "82%", padding: 20, paddingTop: 10, borderRadius: 24, backgroundColor: "#F8F8FB" }, sheetHandle: { width: 38, height: 4, marginBottom: 20, alignSelf: "center", borderRadius: 2, backgroundColor: "#D3D5DD" }, moveEyebrow: { color: "#6266EA", fontSize: 9, fontWeight: "800", letterSpacing: 1.2 }, moveTitle: { marginTop: 6, color: "#171923", fontSize: 22, lineHeight: 28, fontWeight: "800", letterSpacing: -0.6 }, moveSubtitle: { marginTop: 5, marginBottom: 17, color: "#7C818E", fontSize: 12 }, moveOptions: { maxHeight: 390 }, moveOption: { minHeight: 58, marginBottom: 8, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 11, borderWidth: 1, borderColor: "#E1E3EA", borderRadius: 14, backgroundColor: "white" }, moveOptionSelected: { borderColor: "#D8DAE5", backgroundColor: "#EEEFF4" }, categoryDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: "#8E91ED" }, categoryDotSelected: { backgroundColor: "#A7ABB6" }, moveOptionText: { flex: 1, color: "#242630", fontSize: 14, fontWeight: "700" }, moveOptionTextSelected: { color: "#7B808D" }, currentLabel: { color: "#9296A2", fontSize: 8, fontWeight: "800", letterSpacing: 0.8 }, moveChevron: { color: "#6266EA", fontSize: 25 }, moveCancel: { minHeight: 48, marginTop: 8, alignItems: "center", justifyContent: "center" }, moveCancelText: { color: "#666B78", fontSize: 13, fontWeight: "700" },
  mobileHeader: { minHeight: 72, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "white", borderBottomWidth: StyleSheet.hairlineWidth, borderColor: "#E3E5EC" },
  mobileBrand: { flexDirection: "row", alignItems: "center", gap: 11 }, mobileLogo: { width: 38, height: 38, padding: 9, borderRadius: 11, flexDirection: "row", alignItems: "flex-end", gap: 3, backgroundColor: "#1B1E2B" }, mobileTitle: { color: "#171923", fontSize: 17, fontWeight: "800", letterSpacing: -0.4 }, connectionText: { marginTop: 2, color: "#7A7F8D", fontSize: 10, fontWeight: "600" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 7 }, iconAction: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 11, borderWidth: 1, borderColor: "#E2E4EB", backgroundColor: "#FAFAFC" }, iconActionText: { color: "#5F6471", fontSize: 16 }, automationActionText: { color: "#6266EA", fontSize: 15 }, avatarAction: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 18, backgroundColor: "#ECEEFF" }, avatarText: { color: "#6266EA", fontSize: 10, fontWeight: "800" },
  mobileOverview: { paddingHorizontal: 20, paddingTop: 22, paddingBottom: 15, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, overviewEyebrow: { color: "#6266EA", fontSize: 9, fontWeight: "800", letterSpacing: 1.2 }, overviewTitle: { marginTop: 5, color: "#171923", fontSize: 24, lineHeight: 29, fontWeight: "800", letterSpacing: -0.8 }, liveMetric: { minWidth: 60, paddingVertical: 8, paddingHorizontal: 11, alignItems: "center", borderRadius: 13, borderWidth: 1, borderColor: "#E2E4EC", backgroundColor: "white" }, liveMetricNumber: { color: "#171923", fontSize: 16, fontWeight: "800" }, liveMetricLabel: { color: "#7B808E", fontSize: 9, fontWeight: "600" },
  projectFilter: { minHeight: 50, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: "#E0E2E9", borderRadius: 13, backgroundColor: "white" }, projectFilterLabel: { color: "#969AA6", fontSize: 8, fontWeight: "800", letterSpacing: 1 }, projectFilterValue: { marginTop: 3, color: "#292C35", fontSize: 13, fontWeight: "700" }, projectFilterChevron: { color: "#6266EA", fontSize: 19 },
  categoryTabsScroll: { flexGrow: 0, flexShrink: 0, height: 52 }, categoryTabs: { height: 52, paddingHorizontal: 16, paddingBottom: 10, alignItems: "center", gap: 8 }, categoryTab: { height: 38, paddingLeft: 14, paddingRight: 7, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 19, borderWidth: 1, borderColor: "#E0E2E9", backgroundColor: "white" }, categoryTabActive: { borderColor: "#1B1E2B", backgroundColor: "#1B1E2B" }, categoryTabText: { color: "#686D7A", fontSize: 12, fontWeight: "700" }, categoryTabTextActive: { color: "white" }, categoryTabCount: { minWidth: 23, height: 23, paddingHorizontal: 6, textAlign: "center", textAlignVertical: "center", borderRadius: 12, overflow: "hidden", color: "#6F7481", backgroundColor: "#F0F1F5", fontSize: 10, fontWeight: "800" }, categoryTabCountActive: { color: "#1B1E2B", backgroundColor: "white" },
  taskList: { flex: 1 }, taskListContent: { paddingHorizontal: 16, paddingBottom: 28 }, listHeading: { marginTop: 7, marginBottom: 12, paddingHorizontal: 3, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, listTitle: { color: "#242630", fontSize: 14, fontWeight: "800" }, listCount: { color: "#858A96", fontSize: 10, fontWeight: "600" },
  cardTop: { minHeight: 24, marginBottom: 9, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, projectPill: { maxWidth: "68%", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 7, overflow: "hidden", color: "#747987", backgroundColor: "#F1F2F6", fontSize: 9, fontWeight: "700" }, workingPill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: "#EEEFFF" }, workingPillText: { color: "#6266EA", fontSize: 9, fontWeight: "800" }, cardBottom: { marginTop: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, openArrow: { color: "#6266EA", fontSize: 18, fontWeight: "700" }, moveLinkText: { color: "#858A96", fontSize: 10, fontWeight: "700" },
  emptyColumn: { minHeight: 240, marginTop: 5, alignItems: "center", justifyContent: "center", borderWidth: 1, borderStyle: "dashed", borderColor: "#D8DAE3", borderRadius: 18, backgroundColor: "rgba(255,255,255,.45)" }, emptyIcon: { color: "#A1A5B1", fontSize: 31 }, emptyTitle: { marginTop: 9, color: "#333640", fontSize: 15, fontWeight: "700" }, emptyText: { maxWidth: 230, marginTop: 5, textAlign: "center", color: "#858A96", fontSize: 11, lineHeight: 17 },
  chatBackButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 12, borderWidth: 1, borderColor: "#E1E3EA", backgroundColor: "#FAFAFC" }, chatTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 }, chatState: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8, backgroundColor: "#F0F1F5" }, chatStateLive: { backgroundColor: "#EEEFFF" }, chatStateText: { color: "#7C818E", fontSize: 8, fontWeight: "800" }, chatStateTextLive: { color: "#6266EA" }, stopButton: { paddingHorizontal: 11, paddingVertical: 8, borderRadius: 10, backgroundColor: "#FFF0ED" },
  choiceDialog: { maxHeight: "78%", padding: 20, paddingTop: 10, borderRadius: 24, backgroundColor: "#F8F8FB" }, choiceList: { marginTop: 16 }, choiceRow: { minHeight: 60, marginBottom: 8, paddingHorizontal: 15, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: "#E1E3EA", borderRadius: 14, backgroundColor: "white" }, choiceRowSelected: { borderColor: "#8D90ED", backgroundColor: "#F1F1FF" }, choiceLabel: { color: "#262832", fontSize: 14, fontWeight: "700" }, choiceCheck: { color: "#6266EA", fontSize: 17, fontWeight: "800" },
  automationComposer: { padding: 14, gap: 10, borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 17, backgroundColor: "white" }, segmented: { padding: 3, flexDirection: "row", borderRadius: 12, backgroundColor: "#EFF0F4" }, segment: { flex: 1, minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: 9 }, segmentActive: { backgroundColor: "#1B1E2B" }, segmentText: { color: "#727784", fontSize: 11, fontWeight: "700" }, segmentTextActive: { color: "white" }, fieldLabel: { marginTop: 5, color: "#8A8F9B", fontSize: 8, fontWeight: "800", letterSpacing: 1 }, miniChoices: { gap: 7 }, miniChoice: { maxWidth: 190, minHeight: 36, paddingHorizontal: 11, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#E0E2E9", borderRadius: 11, backgroundColor: "#F9F9FB" }, miniChoiceActive: { borderColor: "#8588EC", backgroundColor: "#EEEFFF" }, miniChoiceText: { color: "#696E7B", fontSize: 10, fontWeight: "700" }, miniChoiceTextActive: { color: "#5559D8" }, promptInput: { minHeight: 76, textAlignVertical: "top" }, automationSectionTitle: { marginTop: 24, marginBottom: 10, marginLeft: 3, color: "#858A96", fontSize: 9, fontWeight: "800", letterSpacing: 1 }, automationCard: { marginBottom: 10, padding: 14, borderWidth: 1, borderColor: "#E1E3EA", borderRadius: 15, backgroundColor: "white" }, automationCardTop: { flexDirection: "row", alignItems: "center", gap: 11 }, automationIcon: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 11, backgroundColor: "#EEEFFF" }, automationName: { color: "#252832", fontSize: 13, fontWeight: "800" }, automationDescription: { marginTop: 3, color: "#7F8491", fontSize: 10, lineHeight: 15 }, automationError: { marginTop: 4, color: "#B54A3C", fontSize: 9 }, toggle: { width: 42, height: 24, padding: 3, justifyContent: "center", borderRadius: 12, backgroundColor: "#D8DAE1" }, toggleOn: { backgroundColor: "#6266EA" }, toggleKnob: { width: 18, height: 18, borderRadius: 9, backgroundColor: "white" }, toggleKnobOn: { alignSelf: "flex-end" }, deleteAutomation: { marginTop: 10, alignSelf: "flex-end", color: "#B54A3C", fontSize: 10, fontWeight: "700" },
});

const markdownStyles = StyleSheet.create({
  body: { color: "#252832", fontSize: 14, lineHeight: 21 },
  paragraph: { marginTop: 0, marginBottom: 9 },
  heading1: { marginTop: 10, marginBottom: 7, color: "#171923", fontSize: 21, lineHeight: 26, fontWeight: "800" },
  heading2: { marginTop: 10, marginBottom: 7, color: "#171923", fontSize: 18, lineHeight: 23, fontWeight: "800" },
  heading3: { marginTop: 9, marginBottom: 6, color: "#171923", fontSize: 16, lineHeight: 21, fontWeight: "800" },
  bullet_list: { marginVertical: 5 }, ordered_list: { marginVertical: 5 }, list_item: { marginVertical: 2 },
  code_inline: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 5, color: "#3E4380", backgroundColor: "#F0F1F7", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  fence: { marginVertical: 7, padding: 11, borderRadius: 10, color: "#EEF0F5", backgroundColor: "#1D2028", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 11, lineHeight: 17 },
  blockquote: { paddingLeft: 11, borderLeftWidth: 3, borderLeftColor: "#8A8DF3", backgroundColor: "#F5F5FB" },
  link: { color: "#6266EA" }, table: { borderColor: "#DADDE6" }, th: { padding: 6, backgroundColor: "#F1F2F6" }, td: { padding: 6 },
});
