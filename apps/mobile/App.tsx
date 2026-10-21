import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator, Alert, AppState, BackHandler, FlatList, KeyboardAvoidingView, Modal, Platform,
  Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import Markdown from "react-native-markdown-display";
import {
  automationOutcome, automationEditFields, automationUpdateInput, automationDateTimeValue, automationIntervalMinutes, categoryFromTitle, displayTitle as formatTaskTitle, formatAutomationInterval, formatCodexDirectives, parsePairingPayload, threadNameWithTitle, TurnSettingsSync,
  type Automation, type BoardConfig, type BoardNotification, type CreateAutomationInput, type JsonValue, type PairingCredential,
  type PendingRemoteRequest, type QueuedMessage, type ThreadDto, type TurnSettings,
} from "@codex-board/protocol";
import { BoardApi } from "./src/api";
import { ChatDraftStore } from "@codex-board/protocol";
import { createMobileDrafts } from "./src/chatDrafts";
import { ChatKeyboardFrame } from "./src/ChatKeyboardFrame";
import { RetryAutomationAction } from "./src/RetryAutomationAction";
import { clearCredential, hasSeenTour, loadCredential, loadSelectedBoard, markTourSeen, saveCredential, saveSelectedBoard } from "./src/connection";
import { MobileBoardHome } from "./src/MobileBoardHome";
import { AutomationResultModal } from "./src/AutomationResultModal";
import { MobileIcon } from "./src/MobileIcon";
import { ProjectHome } from "./src/ProjectHome";
import { colors } from "./src/theme";
import { MobileNavigation } from "./src/MobileNavigation";
import { MobileActionSheet } from "./src/MobileActionSheet";

const displayTitle = (name?: string | null, preview?: string | null) => formatTaskTitle(name ?? null, preview ?? null);

type JsonObject = Record<string, JsonValue>;
const object = (value: JsonValue | undefined): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const string = (value: JsonValue | undefined): string => typeof value === "string" ? value : "";
const requestThreadId = (request: PendingRemoteRequest) => string(object(request.params).threadId);
const visibleUserMessage = (value: string) => value.replace(/\n*<!-- codex-board-automation:[\s\S]*?-->/g, "").trimEnd();

interface ChatLine { id: string; role: "user" | "assistant" | "activity" | "image"; text: string; title?: string; status?: string; imagePath?: string; }

function ChatMessage({ line, api }: { line: ChatLine; api: BoardApi }) {
  const [expanded, setExpanded] = useState(false);
  if (line.role === "image") return <View style={styles.bubble}><Text style={styles.bubbleLabel}>CODEX IMAGE</Text>{line.imagePath ? <Image source={api.imageSource(line.imagePath)} style={styles.generatedImage} resizeMode="contain" /> : <Text style={styles.bubbleText}>Generated image is unavailable.</Text>}{line.text ? <Text style={styles.imageCaption}>{line.text}</Text> : null}</View>;
  if (line.role === "activity") return <View style={styles.activityCard}>
    <Pressable style={styles.activityToggle} onPress={()=>setExpanded(value=>!value)} accessibilityRole="button" accessibilityState={{expanded}}>
      <MobileIcon name="terminal" size={17} color={colors.textMuted}/><Text style={styles.activityTitle}>{line.title || "Activity"}</Text><Text style={styles.activityStatus}>{line.status}</Text><MobileIcon name={expanded?"chevron-up":"chevron-down"} size={16} color={colors.textMuted}/>
    </Pressable>
    {expanded&&<View style={styles.activityBody}><Markdown style={markdownStyles}>{formatCodexDirectives(line.text || "…")}</Markdown></View>}
  </View>;
  return <View style={[styles.bubble,styles[`bubble_${line.role}`]]}>{line.role==="assistant"&&<Text style={styles.bubbleLabel}>CODEX</Text>}{line.role==="assistant"?<Markdown style={markdownStyles}>{formatCodexDirectives(line.text || "…")}</Markdown>:<Text style={[styles.bubbleText,styles.userText]}>{line.text || "…"}</Text>}</View>;
}

const threadCache = new Map<string, JsonObject>();
const threadWorkModes = new Map<string, "default" | "plan">();

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
        lines.push({ id, role: "user", text: visibleUserMessage(content) });
      } else if (type === "agentMessage") {
        lines.push({ id, role: "assistant", text: string(item.text) });
      } else if (type === "imageView" || type === "imageGeneration") {
        const imagePath = string(item.path) || string(item.savedPath);
        if (imagePath) lines.push({ id, role: "image", text: string(item.revisedPrompt) || string(item.result), imagePath, status: string(item.status) });
      } else if (type === "plan" || type === "reasoning") {
        lines.push({ id, role: "activity", title: type === "plan" ? "Plan" : "Reasoning", text: string(item.text) || string(item.summary) || "Codex activity" });
      } else if (type === "commandExecution") {
        const command = string(item.command) || "Command"; const output = string(item.aggregatedOutput);
        lines.push({ id, role: "activity", title: "Command", status: string(item.status), text: output ? `${command}\n\n${output}` : command });
      } else if (type === "fileChange") {
        const changes = item.changes ? JSON.stringify(item.changes, null, 2) : "Preparing file changes…";
        lines.push({ id, role: "activity", title: "File changes", status: string(item.status), text: changes });
      } else if (["mcpToolCall", "dynamicToolCall", "webSearch"].includes(type)) {
        lines.push({ id, role: "activity", title: type === "webSearch" ? "Web search" : string(item.tool) || "Tool", status: string(item.status), text: string(item.query) || JSON.stringify(item.result || item.arguments || {}, null, 2) });
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

interface ForkTurnChoice { id: string; label: string; }
function forkTurnChoices(thread: JsonObject | null): ForkTurnChoice[] {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  return turns.flatMap((rawTurn, index) => {
    const turn = object(rawTurn);
    const id = string(turn.id);
    if (!id || string(turn.status) === "inProgress") return [];
    const items = Array.isArray(turn.items) ? turn.items.map(object) : [];
    const user = items.find((item) => string(item.type) === "userMessage");
    const content = Array.isArray(user?.content) ? user.content.map((part) => string(object(part).text)).filter(Boolean).join(" ") : string(user?.content);
    const prompt = visibleUserMessage(content).replace(/\s+/g, " ").trim();
    return [{ id, label: `Turn ${index + 1}${prompt ? ` · ${prompt.slice(0, 58)}` : ""}` }];
  });
}

function isWorking(thread: ThreadDto): boolean {
  return string(object(thread.status).type) === "active";
}

function usageSnapshot(value: JsonValue | null): { used: number | null; resetsAt: number | null } {
  const root = object(value || null);
  const limits = object(root.rateLimits || value || null);
  const primary = object(limits.primary);
  return { used: typeof primary.usedPercent === "number" ? primary.usedPercent : null, resetsAt: typeof primary.resetsAt === "number" ? primary.resetsAt : null };
}

function projectLabel(cwd: string | null): string {
  const parts = (cwd || "Local project").split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "Local project";
}

const ALL_PROJECTS = "__all_projects__";
const projectKey = (cwd: string | null): string => (cwd || "").trim().replace(/[\\/]+$/, "").toLocaleLowerCase() || "__local__";

function projectBoards(threads: ThreadDto[], registeredProjects: string[] = []): { key: string; label: string; cwd: string; count: number }[] {
  const sources = [...registeredProjects.map((cwd) => ({ cwd })), ...threads];
  const values = [...new Map(sources.map((source) => {
    const cwd = source.cwd || "Local project";
    return [projectKey(source.cwd), { key: projectKey(source.cwd), cwd, base: projectLabel(source.cwd) }];
  })).values()];
  const duplicateCounts = new Map<string, number>();
  for (const item of values) duplicateCounts.set(item.base, (duplicateCounts.get(item.base) || 0) + 1);
  return values.map((item) => {
    const parts = item.cwd.split(/[\\/]/).filter(Boolean);
    const parent = parts.at(-2);
    const label = (duplicateCounts.get(item.base) || 0) > 1 && parent ? `${parent} / ${item.base}` : item.base;
    return { key: item.key, cwd: item.cwd, label, count: threads.filter((thread) => projectKey(thread.cwd) === item.key).length };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

function taskName(category: string, title: string): string {
  return category === "Uncategorized" ? title : `${category} - ${title}`;
}

function automationDescription(automation: Automation, threads: ThreadDto[]): string {
  const action = automation.action;
  if (action.kind === "recurringMessage") {
    const thread = threads.find((item) => item.id === action.threadId);
    return `Every ${formatAutomationInterval(action.everyMinutes)} · ${displayTitle(thread?.name || null, thread?.preview || null)}`;
  }
  if (action.kind === "scheduledMessage") return `Once · ${new Date(action.runAt).toLocaleString()}`;
  if (action.kind === "calendarMessage") {
    const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const days = action.weekdays.length === 7 ? "Every day" : action.weekdays.map((day) => labels[day]).join(", ");
    return `${days} · ${String(Math.floor(action.minuteOfDay / 60)).padStart(2, "0")}:${String(action.minuteOfDay % 60).padStart(2, "0")}`;
  }
  if (action.kind === "categoryPipeline") return `${action.fromCategory} → ${action.toCategory} after ${action.afterMinutes} min`;
  return `${action.fromCategory} → ${action.toCategory} · ${new Date(action.runAt).toLocaleString()}`;
}

function parseLocalDateTime(value: string): number {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!match) return Number.NaN;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])).getTime();
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

function MobileChatComposer({ threadId, api, working, preferences, onChanged, onQueueChanged, drafts }: { threadId: string; api: BoardApi; working: boolean; preferences: TurnSettingsSync; onChanged: () => void; onQueueChanged: () => void; drafts: ChatDraftStore }) {
  const insets = useSafeAreaInsets();
  const subscribeDraft = useCallback((listener: () => void) => drafts.subscribe(threadId, listener), [drafts, threadId]);
  const draftSnapshot = useCallback(() => drafts.getSnapshot(threadId), [drafts, threadId]);
  const { draft: saved, ready: draftReady, error: draftError } = useSyncExternalStore(subscribeDraft, draftSnapshot);
  const draft = saved.text;
  const attachments = saved.attachments;
  const sendingRef = useRef(false);
  useEffect(() => {
    void drafts.load(threadId);
    const background = AppState.addEventListener("change", state => { if (state !== "active") void drafts.flush(threadId).catch(() => undefined); });
    return () => { background.remove(); void drafts.flush(threadId).catch(() => undefined); };
  }, [drafts, threadId]);
  const [busy, setBusy] = useState(false);
  const { settings, ready, saving, error: settingsError } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const { model = "", effort = "", summary = "auto", serviceTier: tier = "" } = settings;
  const [workMode, setWorkMode] = useState<"default" | "plan">(() => threadWorkModes.get(threadId) || "default");
  const [models, setModels] = useState<Array<{ id: string; name: string; efforts: string[]; tiers: Array<{ id: string; name: string }> }>>([]);
  const [activeTool, setActiveTool] = useState<"model" | "attachments" | null>(null);
  const [uploading, setUploading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogRevision, setCatalogRevision] = useState(0);
  useEffect(() => { let alive = true; setCatalogError(null); void api.models().then((value) => { const data = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).data : null; if (!alive) return; if (!Array.isArray(data)) {setCatalogError("Model catalog unavailable");return;} const next = data.map((item) => { const row = item as Record<string, unknown>; const effortItems = Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts.map((entry) => (entry as Record<string, unknown>)?.reasoningEffort).filter((entry): entry is string => typeof entry === "string") : []; const tierItems = Array.isArray(row.serviceTiers) ? row.serviceTiers.map((entry) => { const value = entry as Record<string, unknown>; return { id: String(value?.id || ""), name: String(value?.name || value?.id || "") }; }).filter((entry) => entry.id) : []; return { id: typeof row.model === "string" ? row.model : String(row.id || ""), name: typeof row.displayName === "string" ? row.displayName : String(row.model || row.id || ""), efforts: effortItems, tiers: tierItems }; }).filter((item) => item.id); setModels(next); }).catch((error) => {if(alive)setCatalogError(error instanceof Error?error.message:String(error));}); return () => { alive = false; }; }, [api, catalogRevision]);
  const selectedModel = models.find((item) => item.id === model);
  const availableEfforts = selectedModel?.efforts.length ? selectedModel.efforts : ["low", "medium", "high", "xhigh"];
  function saveSettings(patch: TurnSettings) { void preferences.update(patch).catch(() => undefined); }

  async function send() {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || sendingRef.current || !draftReady) return;
    sendingRef.current = true; setBusy(true);
    try {
      const confirmed = await preferences.flush();
      if (!confirmed.model && api.sharedTurnSettings !== false) { setActiveTool("model"); return; }
      const outcome = await api.send(threadId, text, attachments.map((attachment) => attachment.dataUrl), confirmed.model ? { ...confirmed, mode: workMode } : undefined);
      if (outcome.queued) onQueueChanged();
      drafts.accepted(threadId, saved); onChanged();
    }
    catch (error) { Alert.alert("Could not send", error instanceof Error ? error.message : String(error)); }
    finally { sendingRef.current = false; setBusy(false); }
  }

  async function pickImage() {
    if (uploading) return;
    setUploading(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: 10, base64: true, quality: 0.85 });
      if (result.canceled || result.assets.length === 0) return;
      const selected = result.assets.filter((asset) => Boolean(asset.base64)).map((asset, index) => ({ id: `${Date.now()}-${index}-${Math.random()}`, name: asset.fileName || `Image ${index + 1}`, uri: asset.uri, dataUrl: `data:${asset.mimeType || "image/jpeg"};base64,${asset.base64}` }));
      if (selected.length !== result.assets.length) Alert.alert("Some images skipped", "Codex Board could not read one or more selected images.");
      drafts.update(threadId, current => ({ ...current, attachments: [...current.attachments, ...selected] }));
    }
    catch (error) { Alert.alert("Could not attach images", error instanceof Error ? error.message : String(error)); }
    finally { setUploading(false); setActiveTool(null); }
  }
  async function compact() {
    if (working) return;
    setBusy(true);
    try { await api.compact(threadId); onChanged(); }
    catch (error) { Alert.alert("Could not compact conversation", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <View>
    <View style={styles.composerShell}><View style={styles.composerCard}>
      <View style={styles.workModeRow} accessibilityLabel="Work mode"><Text style={styles.workModeLabel}>MODE</Text>{(["default", "plan"] as const).map(mode=><Pressable key={mode} accessibilityRole="button" accessibilityState={{selected:workMode===mode}} style={[styles.workModeButton,workMode===mode&&styles.workModeButtonActive]} onPress={()=>{threadWorkModes.set(threadId,mode);setWorkMode(mode);}}><Text style={[styles.workModeText,workMode===mode&&styles.workModeTextActive]}>{mode==="plan"?"Plan":"Default"}</Text></Pressable>)}</View>
      <TextInput value={draft} onChangeText={text => drafts.update(threadId, current => ({ ...current, text }))} editable={draftReady} scrollEnabled style={styles.composerInput} placeholder={working ? "Add to queue…" : "Message Codex…"} multiline />
      {!ready ? <Text style={styles.modelRequiredHint}>Loading conversation settings…</Text> : !model && api.sharedTurnSettings !== false ? <Text style={styles.modelRequiredHint}>Choose a model to start.</Text> : null}
      {draftError && <Text accessibilityRole="alert" style={styles.modelRequiredHint}>{draftError}</Text>}
      {settingsError&&<Text accessibilityRole="alert" style={styles.modelRequiredHint}>Settings could not be saved: {settingsError}</Text>}
      {attachments.length > 0 && <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.composerAttachmentStrip}>{attachments.map((attachment) => <View key={attachment.id} style={styles.composerAttachmentChip}><Image source={{ uri: attachment.dataUrl }} style={styles.composerAttachmentThumb} /><Text numberOfLines={1} style={styles.composerAttachmentName}>{attachment.name}</Text><Pressable accessibilityRole="button" accessibilityLabel={`Remove ${attachment.name}`} style={styles.composerAttachmentRemove} onPress={() => drafts.update(threadId, current => ({ ...current, attachments: current.attachments.filter(item => item.id !== attachment.id) }))}><MobileIcon name="x" size={18} color={colors.textMuted}/></Pressable></View>)}</ScrollView>}
      <View style={styles.composerBottomRow}><View style={styles.composerToolRow}>
        <Pressable accessibilityRole="button" accessibilityLabel="Model and turn settings" style={styles.mobileToolButton} onPress={() => setActiveTool((current) => current === "model" ? null : "model")}><Text style={styles.mobileToolLabel}>{saving ? "Saving…" : "Model"}</Text><Text style={styles.mobileToolValue} numberOfLines={1}>{selectedModel?.name || model || (ready ? api.sharedTurnSettings === false ? "Conversation model" : "Choose model" : "Loading…")}</Text><MobileIcon name="chevron-down" size={16} color={colors.textMuted}/></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Attachments" style={styles.composerAttachButton} disabled={uploading} onPress={() => setActiveTool((current) => current === "attachments" ? null : "attachments")}><MobileIcon name="paperclip" size={20} color={colors.primary}/></Pressable>
      </View><Pressable disabled={(!draft.trim() && attachments.length === 0) || busy || !ready || !draftReady} style={[styles.send, ((!draft.trim() && attachments.length === 0) || busy || !ready) && styles.disabled]} onPress={() => void send()}><Text style={styles.primaryButtonText}>{working ? "Queue" : "Send"}</Text></Pressable></View>
    </View></View>
    <Modal visible={activeTool !== null} transparent animationType="fade" onRequestClose={() => setActiveTool(null)}><View style={[styles.toolModalBackdrop,{paddingBottom:Math.max(insets.bottom,12)}]}><Pressable style={StyleSheet.absoluteFill} onPress={() => setActiveTool(null)} accessibilityRole="button" accessibilityLabel="Close chat tools"/><View style={activeTool === "model" ? styles.toolModal : styles.attachModal}>
      <View style={styles.toolModalHeader}><View style={{flex:1,minWidth:0}}><Text style={styles.toolModalTitle}>{activeTool === "model" ? "Model & turn settings" : "Attachments"}</Text><Text style={styles.toolModalSubtitle}>{activeTool === "model" ? (api.sharedTurnSettings === false ? "Saved on this phone · update PC to share settings" : models.length ? `${models.length} models available in Codex` : "Loading model catalog…") : "Select one or more images to send with your message"}</Text></View><Pressable hitSlop={10} style={styles.modalCloseButton} onPress={() => setActiveTool(null)}><MobileIcon name="x" size={22} color={colors.textMuted}/></Pressable></View>
      <ScrollView style={{flexShrink:1}} keyboardShouldPersistTaps="handled" contentContainerStyle={{paddingBottom:8}}>
      {catalogError&&activeTool==="model"&&<Pressable style={styles.catalogRetry} onPress={()=>setCatalogRevision(value=>value+1)} accessibilityRole="button"><Text style={styles.catalogRetryText}>Could not load models. Tap to retry.</Text></Pressable>}
      {activeTool === "model" ? <>
        <View style={styles.modelOptionList}>{models.map((item) => <Pressable key={item.id} style={[styles.modelOption, model === item.id && styles.modelOptionSelected]} onPress={() => { saveSettings({ model:item.id, effort:"", serviceTier:"" }); }}><View style={styles.modelOptionCopy}><Text style={styles.modelOptionName}>{item.name}</Text><Text numberOfLines={1} style={styles.modelOptionId}>{item.id}</Text></View>{model === item.id && <MobileIcon name="check-circle" size={20} color={colors.primary}/>}</Pressable>)}</View>
        <Text style={styles.toolSectionLabel}>REASONING EFFORT</Text><View style={styles.toolChoiceRow}>{["",...availableEfforts].map((item) => <Pressable key={item} style={[styles.toolChoice, effort === item && styles.toolChoiceSelected]} onPress={() => { saveSettings({effort:effort===item?"":item}); }}><Text style={[styles.toolChoiceText, effort === item && styles.toolChoiceTextSelected]}>{item||"Default"}</Text></Pressable>)}</View>
        <Text style={styles.toolSectionLabel}>SUMMARY</Text><View style={styles.toolChoiceRow}>{["auto", "concise", "detailed", "none"].map((item) => <Pressable key={item} style={[styles.toolChoice, summary === item && styles.toolChoiceSelected]} onPress={() => {saveSettings({summary:item});}}><Text style={[styles.toolChoiceText, summary === item && styles.toolChoiceTextSelected]}>{item||"Default"}</Text></Pressable>)}</View>
        {Boolean(selectedModel?.tiers.length) && <><Text style={styles.toolSectionLabel}>SERVICE TIER</Text><View style={styles.toolChoiceRow}>{selectedModel?.tiers.map((item) => <Pressable key={item.id} style={[styles.toolChoice, tier === item.id && styles.toolChoiceSelected]} onPress={() => {saveSettings({serviceTier:tier===item.id?"":item.id});}}><Text style={[styles.toolChoiceText, tier === item.id && styles.toolChoiceTextSelected]}>{item.name}</Text></Pressable>)}</View></>}
        <View style={styles.toolModalFooter}><Pressable disabled={!model || working || busy} style={[styles.compactMobileButton, (!model || working || busy) && styles.disabled]} onPress={() => void compact()}><Text style={styles.compactMobileText}>{busy ? "Compacting…" : "Compact conversation"}</Text></Pressable><Pressable style={styles.toolDoneButton} onPress={() => setActiveTool(null)}><Text style={styles.toolDoneText}>Done</Text></Pressable></View>
      </> : <Pressable disabled={uploading} style={[styles.attachChoice, uploading && styles.disabled]} onPress={() => void pickImage()}><View style={styles.attachChoiceIcon}><MobileIcon name="image" size={19} color={colors.primary}/></View><View><Text style={styles.attachChoiceTitle}>Choose images</Text><Text style={styles.attachChoiceSubtitle}>Select multiple from your photo library</Text></View></Pressable>}
      </ScrollView>
    </View></View></Modal>
  </View>;
}

function Chat({ thread, api, queue, requests, eventRevision, preferences, onClose, onChanged, onQueueChanged, onFork, onRename, drafts }: { thread: ThreadDto; api: BoardApi; queue: QueuedMessage[]; requests: PendingRemoteRequest[]; eventRevision: number; preferences: TurnSettingsSync; onClose: () => void; onChanged: () => void; onQueueChanged: () => void; onFork: () => void; onRename: () => void; drafts: ChatDraftStore }) {
  const [loaded, setLoaded] = useState<JsonObject | null>(() => threadCache.get(thread.id) || null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(!loaded);
  const [historyRefreshing, setHistoryRefreshing] = useState(false);
  const hasHistory = useRef(Boolean(loaded));
  const historyRequest = useRef(0);
  const lines = useMemo(() => conversation(loaded), [loaded]);
  const timeline = useMemo(() => [...lines].reverse(), [lines]);
  const refresh = useCallback(() => {
    const request = ++historyRequest.current;
    if (hasHistory.current) setHistoryRefreshing(true);
    void api.thread(thread.id)
      .then((next) => {
        if (request !== historyRequest.current) return;
        threadCache.set(thread.id, next); hasHistory.current = true; setLoaded(next); setHistoryError(null);
      })
      .catch((error) => { if (request === historyRequest.current) setHistoryError(error instanceof Error ? error.message : String(error)); })
      .finally(() => {
        if (request !== historyRequest.current) return;
        setHistoryLoading(false); setHistoryRefreshing(false);
      });
  }, [api, thread.id]);
  useEffect(refresh, [refresh]);
  useEffect(() => { if (eventRevision > 0) refresh(); }, [eventRevision, refresh]);
  useEffect(() => () => { historyRequest.current += 1; }, []);

  const turnId = activeTurnId(loaded);
  return <ChatKeyboardFrame>
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to board" style={styles.chatBackButton} onPress={onClose}><MobileIcon name="chevron-left" size={25} color={colors.text}/></Pressable>
      <View style={styles.headerCopy}><View style={styles.chatTitleRow}><Text style={styles.headerTitle} numberOfLines={1}>{displayTitle(thread.name, thread.preview)}</Text><View style={[styles.chatState, turnId && styles.chatStateLive]}><Text style={[styles.chatStateText, turnId && styles.chatStateTextLive]}>{turnId ? "Working" : "Ready"}</Text></View></View><Text style={styles.headerMeta} numberOfLines={1}>{projectLabel(thread.cwd)}{thread.forkedFromId?" · Forked conversation":""}</Text></View>
      <View style={styles.topbarActions}>
        <Pressable accessibilityRole="button" accessibilityLabel="Conversation actions" style={styles.chatBackButton} onPress={()=>setActionsOpen(true)}><MobileIcon name="more-horizontal" size={23} color={colors.text}/></Pressable>
      </View>
    </View>
    {historyRefreshing && <View accessibilityRole="progressbar" accessibilityLabel="Updating conversation" style={{ minHeight: 32, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#F6F6FF", borderBottomWidth: StyleSheet.hairlineWidth, borderColor: "#E1E3EA" }}><ActivityIndicator size="small" color={colors.primary}/><Text style={{ color: colors.textMuted, fontSize: 11 }}>Updating messages…</Text></View>}
    {historyError&&<Pressable style={styles.connectionBanner} onPress={refresh} accessibilityRole="button"><Text style={styles.connectionBannerText}>Could not refresh the conversation · Tap to retry</Text></Pressable>}
    <FlatList inverted style={styles.chat} contentContainerStyle={styles.chatContent} data={timeline} keyExtractor={(item) => item.id} maintainVisibleContentPosition={{ minIndexForVisible: 0 }} ListEmptyComponent={historyLoading?<ActivityIndicator style={{padding:24}} color={colors.primary}/>:<Text style={styles.empty}>{historyError?"Conversation unavailable":"No messages yet."}</Text>} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" renderItem={({ item }) => <ChatMessage line={item} api={api}/>} ListHeaderComponent={<>
      {queue.length > 0 && <View style={styles.queueBox}><Text style={styles.requestTitle}>{queue.length} queued</Text>{queue.map((message, index) => { const count = message.imageUrls?.length || Number(Boolean(message.imageUrl)); return <View key={message.id} style={styles.queueRow}><Text style={styles.queueIndex}>{index + 1}</Text><Text style={styles.queueText}>{message.text || `${count} image${count === 1 ? "" : "s"} attached`}</Text><Pressable onPress={() => void api.removeQueued(thread.id, message.id).then(() => { onQueueChanged(); onChanged(); })}><MobileIcon name="x" size={18} color={colors.textMuted}/></Pressable></View>; })}</View>}
      {requests.map((request) => <RequestCard key={JSON.stringify(request.requestId)} request={request} api={api} onDone={onChanged} />)}
    </>} />
    <View style={{ backgroundColor: "white" }}><MobileChatComposer drafts={drafts} key={thread.id} threadId={thread.id} api={api} working={Boolean(turnId)} preferences={preferences} onChanged={onChanged} onQueueChanged={onQueueChanged} /></View>
    {actionsOpen&&<MobileActionSheet title="Conversation" onClose={()=>setActionsOpen(false)} actions={[
      {label:"Rename conversation",icon:"edit-2",onPress:onRename},
      {label:"Fork conversation",icon:"git-branch",onPress:onFork},
      ...(turnId?[{label:"Stop Codex",icon:"stop-circle" as const,onPress:()=>{void api.interrupt(thread.id,turnId).then(onChanged).catch(error=>Alert.alert("Could not stop Codex",String(error)));}}]:[]),
    ]}/>}
  </ChatKeyboardFrame>;
}

function CategoryManager({ config, threads, api, onClose, onSaved, onOpenTour, onDisconnect }: { config: BoardConfig; threads: ThreadDto[]; api: BoardApi; onClose: () => void; onSaved: () => void; onOpenTour: () => void; onDisconnect: () => void }) {
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

  return <Modal animationType="slide" onRequestClose={onClose}><SafeAreaView style={styles.page}><View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel="Close category manager" style={styles.chatBackButton} onPress={onClose}><MobileIcon name="x" size={24} color={colors.text}/></Pressable><View style={styles.headerCopy}><Text style={styles.headerTitle}>Settings</Text><Text style={styles.headerMeta}>Synced with desktop in real time</Text></View></View><ScrollView contentContainerStyle={styles.manager}>
    <View style={styles.managerIntro}><Text style={styles.overviewEyebrow}>BOARD STRUCTURE</Text><Text style={styles.managerTitle}>Make the board yours</Text><Text style={styles.managerSubtitle}>Create, rename and reorder columns. Categories are driven by your prefixes.</Text></View>
    <View style={styles.modeRow}><View style={styles.categoryCopy}><Text style={styles.cardTitle}>Approvals</Text><Text style={styles.headerMeta}>{config.approvalMode === "auto" ? "Commands and changes are approved automatically" : "Ask on desktop or mobile"}</Text></View><Pressable style={styles.denyButton} onPress={() => void api.updateBoard({ ...config, approvalMode: config.approvalMode === "auto" ? "ask" : "auto" }).then(onSaved)}><Text>{config.approvalMode === "auto" ? "Use Ask" : "Use Auto"}</Text></Pressable></View>
    <View style={styles.addRow}><TextInput style={[styles.smallInput, { flex: 1 }]} value={draft} onChangeText={setDraft} placeholder="Category name" /><Pressable disabled={busy} style={styles.allowButton} onPress={() => void add()}><Text style={styles.primaryButtonText}>Add</Text></Pressable></View>
    {categories.map((category, index) => { const count = threads.filter((thread) => categoryFromTitle(thread.name) === category).length; return <View key={category} style={styles.categoryRow}><View style={styles.categoryCopy}><Text style={styles.cardTitle}>{category}</Text><Text style={styles.headerMeta}>{count} tasks</Text></View><Pressable disabled={index === 0 || busy} onPress={() => { const next = [...categories]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; setCategories(next); void save(next); }}><View style={{width:44,height:44,alignItems:"center",justifyContent:"center"}}><MobileIcon name="arrow-up" size={19} color={colors.textMuted}/></View></Pressable><Pressable disabled={index === categories.length - 1 || busy} onPress={() => { const next = [...categories]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; setCategories(next); void save(next); }}><View style={{width:44,height:44,alignItems:"center",justifyContent:"center"}}><MobileIcon name="arrow-down" size={19} color={colors.textMuted}/></View></Pressable><Pressable disabled={busy} onPress={() => rename(category)}><Text style={styles.editButton}>Edit</Text></Pressable>{editing === category && <Pressable onPress={() => void applyRename(category)}><Text style={styles.editButton}>Rename</Text></Pressable>}{count === 0 && <Pressable disabled={busy} onPress={() => { const next = categories.filter((item) => item !== category); setCategories(next); void save(next); }}><Text style={styles.deleteButton}>Delete</Text></Pressable>}</View>; })}
    <Text style={styles.automationSectionTitle}>HELP & CONNECTION</Text>
    <Pressable style={styles.settingsRow} onPress={() => { onClose(); onOpenTour(); }}><View><Text style={styles.cardTitle}>Product tour</Text><Text style={styles.headerMeta}>Reopen the illustrated guide</Text></View><MobileIcon name="chevron-right" size={18} color={colors.textMuted}/></Pressable>
    <Pressable style={styles.settingsRow} onPress={() => Alert.alert("Disconnect this phone?", "You can pair it again from the desktop Remote screen.", [{ text: "Cancel", style: "cancel" }, { text: "Disconnect", style: "destructive", onPress: onDisconnect }])}><View><Text style={styles.cardTitle}>Remote connection</Text><Text style={styles.headerMeta}>Forget this PC and pairing token</Text></View><Text style={styles.deleteButton}>Disconnect</Text></Pressable>
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
  return <Modal transparent animationType="fade" onRequestClose={() => { if (!busy) onClose(); }}><View style={styles.modalBackdrop}><Pressable disabled={busy} style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close move task dialog"/><View style={styles.moveDialog}><View style={styles.sheetHandle} /><Text style={styles.moveEyebrow}>MOVE TASK</Text><Text style={styles.moveTitle} numberOfLines={2}>{displayTitle(thread.name, thread.preview)}</Text><Text style={styles.moveSubtitle}>Choose the next board stage.</Text><ScrollView style={styles.moveOptions}>{categories.map((category) => { const selected = category === current; return <Pressable key={category} disabled={busy || selected} style={[styles.moveOption, selected && styles.moveOptionSelected]} onPress={() => void move(category)}><View style={[styles.categoryDot, selected && styles.categoryDotSelected]} /><Text style={[styles.moveOptionText, selected && styles.moveOptionTextSelected]}>{category}</Text>{selected ? <Text style={styles.currentLabel}>CURRENT</Text> : <MobileIcon name="chevron-right" size={18} color={colors.textMuted}/>}</Pressable>; })}</ScrollView><Pressable style={styles.moveCancel} onPress={onClose}><Text style={styles.moveCancelText}>Cancel</Text></Pressable></View></View></Modal>;
}

function NewTaskModal({ api, threads, projects, categories, defaultProjectKey, onClose, onCreated }: { api: BoardApi; threads: ThreadDto[]; projects: string[]; categories: string[]; defaultProjectKey?: string; onClose: () => void; onCreated: (thread: ThreadDto) => void }) {
  const choices = projectBoards(threads, projects).filter((project) => project.key !== "__local__");
  const [cwd, setCwd] = useState(choices.find((project) => project.key === defaultProjectKey)?.cwd || choices[0]?.cwd || ""); const [category, setCategory] = useState(categories[0] || "Uncategorized"); const [title, setTitle] = useState(""); const [prompt, setPrompt] = useState(""); const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<Array<{ id: string; name: string; uri: string; dataUrl: string }>>([]);
  const [uploading, setUploading] = useState(false);
  async function pickImages() {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: 10, base64: true, quality: 0.85 });
    if (result.canceled || result.assets.length === 0) return;
    setUploading(true);
    try {
      const selected = result.assets.filter((asset) => Boolean(asset.base64)).map((asset, index) => ({ id: `${Date.now()}-${index}-${Math.random()}`, name: asset.fileName || `Image ${index + 1}`, uri: asset.uri, dataUrl: `data:${asset.mimeType || "image/jpeg"};base64,${asset.base64}` }));
      if (selected.length !== result.assets.length) Alert.alert("Some images skipped", "Codex Board could not read one or more selected images.");
      setAttachments((current) => [...current, ...selected]);
    } catch (error) { Alert.alert("Could not attach images", error instanceof Error ? error.message : String(error)); }
    finally { setUploading(false); }
  }
  async function create() { setBusy(true); try { const created = await api.createThread({ cwd, category, title: title.trim(), prompt: prompt.trim(), imageUrls: attachments.map((attachment) => attachment.dataUrl) }); onCreated(created); } catch (error) { Alert.alert("Could not create task", error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }
  return <Modal animationType="slide" onRequestClose={onClose}><SafeAreaView style={styles.page}><View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel="Cancel new task" style={styles.chatBackButton} onPress={onClose}><MobileIcon name="x" size={24} color={colors.text}/></Pressable><View style={styles.headerCopy}><Text style={styles.headerTitle}>New Codex task</Text><Text style={styles.headerMeta}>Create and start directly from mobile</Text></View></View><ScrollView contentContainerStyle={styles.newTaskMobile}><Text style={styles.fieldLabel}>PROJECT</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.miniChoices}>{choices.map((project) => <Pressable key={project.cwd} style={[styles.miniChoice, project.cwd === cwd && styles.miniChoiceActive]} onPress={() => setCwd(project.cwd)}><Text style={[styles.miniChoiceText, project.cwd === cwd && styles.miniChoiceTextActive]}>{project.label}</Text></Pressable>)}</ScrollView><Text style={styles.fieldLabel}>CATEGORY</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.miniChoices}>{categories.map((item) => <Pressable key={item} style={[styles.miniChoice, item === category && styles.miniChoiceActive]} onPress={() => setCategory(item)}><Text style={[styles.miniChoiceText, item === category && styles.miniChoiceTextActive]}>{item}</Text></Pressable>)}</ScrollView><Text style={styles.fieldLabel}>TITLE</Text><TextInput style={styles.smallInput} value={title} onChangeText={setTitle} placeholder="What are we building?" returnKeyType="next" /><Text style={styles.fieldLabel}>FIRST MESSAGE</Text><TextInput style={[styles.smallInput, styles.newTaskPrompt]} value={prompt} onChangeText={setPrompt} multiline blurOnSubmit returnKeyType="send" onSubmitEditing={() => { if (!busy && cwd && title.trim() && prompt.trim()) void create(); }} placeholder="Describe what Codex should do…" />
    <Pressable accessibilityRole="button" disabled={busy || uploading} style={[styles.newTaskAttach, (busy || uploading) && styles.disabled]} onPress={() => void pickImages()}><Text style={styles.newTaskAttachText}>{uploading ? "Loading images…" : "Attach images"}</Text></Pressable>
    {attachments.length > 0 && <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.composerAttachmentStrip}>{attachments.map((attachment) => <View key={attachment.id} style={styles.composerAttachmentChip}><Image source={{ uri: attachment.uri }} style={styles.composerAttachmentThumb} /><Text numberOfLines={1} style={styles.composerAttachmentName}>{attachment.name}</Text><Pressable accessibilityRole="button" accessibilityLabel={`Remove ${attachment.name}`} style={styles.composerAttachmentRemove} onPress={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}><MobileIcon name="x" size={18} color={colors.textMuted}/></Pressable></View>)}</ScrollView>}
    <Pressable disabled={busy || uploading || !cwd || !title.trim() || !prompt.trim()} style={[styles.primaryButton, (busy || uploading || !cwd || !title.trim() || !prompt.trim()) && styles.disabled]} onPress={() => void create()}>{busy ? <ActivityIndicator color="white" /> : <Text style={styles.primaryButtonText}>Create and start</Text>}</Pressable></ScrollView></SafeAreaView></Modal>;
}

function NewProjectModal({ config, api, onClose, onCreated }: { config: BoardConfig; api: BoardApi; onClose: () => void; onCreated: (cwd: string) => void }) {
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const duplicate = config.projects.some((path) => projectKey(path) === projectKey(cwd));
  async function create() { const path = cwd.trim(); if (!path || duplicate) return; setBusy(true); try { await api.updateBoard({ ...config, projects: [...config.projects, path] }); onCreated(path); } catch (error) { Alert.alert("Could not create project", error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }
  return <Modal animationType="slide" onRequestClose={onClose}><SafeAreaView style={styles.page}><View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel="Cancel new project" style={styles.chatBackButton} onPress={onClose}><MobileIcon name="x" size={24} color={colors.text}/></Pressable><View style={styles.headerCopy}><Text style={styles.headerTitle}>Create project</Text><Text style={styles.headerMeta}>Register a working folder on the connected PC</Text></View></View><View style={styles.newTaskMobile}><Text style={styles.fieldLabel}>WORKING FOLDER</Text><TextInput autoFocus style={styles.smallInput} value={cwd} onChangeText={setCwd} placeholder="C:\\Users\\you\\Projects\\my-project" autoCapitalize="none" autoCorrect={false}/>{duplicate&&<Text style={styles.automationError}>This project already exists.</Text>}<Pressable disabled={busy||!cwd.trim()||duplicate} style={[styles.primaryButton,(busy||!cwd.trim()||duplicate)&&styles.disabled]} onPress={()=>void create()}>{busy?<ActivityIndicator color="white"/>:<Text style={styles.primaryButtonText}>Create project</Text>}</Pressable></View></SafeAreaView></Modal>;
}

function RenameThreadModal({ api, thread, onClose, onSaved }: { api: BoardApi; thread: ThreadDto; onClose: () => void; onSaved: (thread: ThreadDto) => void }) {
  const [title,setTitle] = useState(displayTitle(thread.name,thread.preview));
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string|null>(null);
  async function save() {
    if(busy||!title.trim())return;
    setBusy(true);setError(null);
    try {
      const latest = await api.thread(thread.id);
      const saved = await api.rename(thread.id,threadNameWithTitle(string(latest.name)||null,string(latest.preview)||null,title));
      onSaved(saved);
    } catch(cause) {setError(cause instanceof Error?cause.message:String(cause))}
    finally {setBusy(false)}
  }
  return <Modal transparent animationType="fade" onRequestClose={()=>{if(!busy)onClose()}}><KeyboardAvoidingView behavior={Platform.OS==="ios"?"padding":undefined} style={styles.modalBackdrop}><Pressable disabled={busy} style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close rename dialog"/><View style={styles.choiceDialog}>
    <Text style={styles.moveTitle}>Rename conversation</Text><Text style={styles.moveSubtitle}>Category, project and history stay the same.</Text>
    <TextInput autoFocus style={styles.smallInput} value={title} editable={!busy} onChangeText={setTitle} onSubmitEditing={()=>void save()} returnKeyType="done"/>
    {error&&<Text style={styles.automationError}>{error}</Text>}
    <Pressable disabled={busy||!title.trim()} style={[styles.primaryButton,(busy||!title.trim())&&styles.disabled]} onPress={()=>void save()}>{busy?<ActivityIndicator color="white"/>:<Text style={styles.primaryButtonText}>Save title</Text>}</Pressable>
    <Pressable disabled={busy} style={styles.moveCancel} onPress={onClose}><Text style={styles.moveCancelText}>Cancel</Text></Pressable>
  </View></KeyboardAvoidingView></Modal>;
}

function ForkThreadModal({ api, thread, categories, onClose, onCreated }: { api: BoardApi; thread: ThreadDto; categories: string[]; onClose: () => void; onCreated: (thread: ThreadDto) => void }) {
  const [category, setCategory] = useState(categoryFromTitle(thread.name));
  const [title, setTitle] = useState(`${displayTitle(thread.name, thread.preview)} (fork)`);
  const [lastTurnId, setLastTurnId] = useState("");
  const [turns, setTurns] = useState<ForkTurnChoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api.thread(thread.id).then((loaded) => { if (!cancelled) setTurns(forkTurnChoices(loaded)); }).catch((error) => Alert.alert("History unavailable", error instanceof Error ? error.message : String(error))).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, thread.id]);
  async function create() {
    setBusy(true);
    try { onCreated(await api.forkThread(thread.id, { category, title: title.trim(), lastTurnId: lastTurnId || null })); }
    catch (error) { Alert.alert("Could not fork task", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <Modal animationType="slide" onRequestClose={onClose}><SafeAreaView style={styles.page}>
    <View style={styles.header}><Pressable disabled={busy} accessibilityRole="button" accessibilityLabel="Cancel fork" style={styles.chatBackButton} onPress={onClose}><MobileIcon name="x" size={24} color={colors.text}/></Pressable><View style={styles.headerCopy}><Text style={styles.headerTitle}>Fork conversation</Text><Text style={styles.headerMeta}>Create an independent task in the same project</Text></View></View>
    <ScrollView contentContainerStyle={styles.newTaskMobile}>
      <View style={styles.forkSourceMobile}><Text style={styles.automationName}>{displayTitle(thread.name, thread.preview)}</Text><Text style={styles.automationDescription} numberOfLines={1}>{thread.cwd || "Local Codex project"}</Text></View>
      <Text style={styles.fieldLabel}>CATEGORY</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.miniChoices}>{categories.map((item) => <Pressable key={item} style={[styles.miniChoice,item===category&&styles.miniChoiceActive]} onPress={()=>setCategory(item)}><Text style={[styles.miniChoiceText,item===category&&styles.miniChoiceTextActive]}>{item}</Text></Pressable>)}</ScrollView>
      <Text style={styles.fieldLabel}>NEW TASK TITLE</Text><TextInput style={styles.smallInput} value={title} onChangeText={setTitle} />
      <Text style={styles.fieldLabel}>HISTORY TO COPY</Text>
      {loading?<ActivityIndicator color="#6266EA"/>:<View><Pressable style={[styles.forkHistoryChoice,!lastTurnId&&styles.forkHistoryChoiceActive]} onPress={()=>setLastTurnId("")}><View style={styles.categoryCopy}><Text style={styles.choiceLabel}>Entire conversation</Text><Text style={styles.headerMeta}>Copy all completed turns</Text></View>{!lastTurnId&&<MobileIcon name="check" size={20} color={colors.primary}/>}</Pressable>{turns.map((turn)=><Pressable key={turn.id} style={[styles.forkHistoryChoice,lastTurnId===turn.id&&styles.forkHistoryChoiceActive]} onPress={()=>setLastTurnId(turn.id)}><Text style={styles.forkHistoryLabel} numberOfLines={2}>{turn.label}</Text>{lastTurnId===turn.id&&<MobileIcon name="check" size={20} color={colors.primary}/>}</Pressable>)}</View>}
      <Text style={styles.forkNoteMobile}>Future messages in the fork and original conversation remain completely independent.</Text>
      <Pressable disabled={busy||loading||!title.trim()} style={[styles.primaryButton,(busy||loading||!title.trim())&&styles.disabled]} onPress={()=>void create()}>{busy?<ActivityIndicator color="white"/>:<Text style={styles.primaryButtonText}>Fork and open</Text>}</Pressable>
    </ScrollView>
  </SafeAreaView></Modal>;
}

function InboxModal({ api, items, onClose, onOpen, onOpenResult, onChanged, initialTab="notifications" }: { api: BoardApi; items: BoardNotification[]; onClose: () => void; onOpen: (id: string) => void; onOpenResult: (item: BoardNotification) => void; onChanged: () => void; initialTab?: "notifications"|"automations" }) {
  const [tab,setTab]=useState<"notifications"|"automations">(initialTab);
  const regular=items.filter(item=>!item.automation); const automations=items.filter(item=>Boolean(item.automation)); const visible=tab==="automations"?automations:regular;
  return <Modal animationType="slide" onRequestClose={onClose}><SafeAreaView style={styles.page}><View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel="Close inbox" style={styles.chatBackButton} onPress={onClose}><MobileIcon name="x" size={24} color={colors.text}/></Pressable><View style={styles.headerCopy}><Text style={styles.headerTitle}>Inbox</Text><Text style={styles.headerMeta}>Notifications and automation results</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Mark all notifications as read" style={styles.topbarIconButton} onPress={()=>void api.markNotificationsRead().then(onChanged)}><MobileIcon name="check-circle" size={20} color={colors.primary}/></Pressable></View><View style={[styles.segmented,{margin:14}]}><Pressable style={[styles.segment,tab==="notifications"&&styles.segmentActive]} onPress={()=>setTab("notifications")}><Text style={[styles.segmentText,tab==="notifications"&&styles.segmentTextActive]}>Notifications ({regular.filter(item=>!item.read).length})</Text></Pressable><Pressable style={[styles.segment,tab==="automations"&&styles.segmentActive]} onPress={()=>setTab("automations")}><Text style={[styles.segmentText,tab==="automations"&&styles.segmentTextActive]}>Automations ({automations.filter(item=>!item.read).length})</Text></Pressable></View><FlatList contentContainerStyle={styles.mobileInbox} data={visible} keyExtractor={item=>item.id} ListEmptyComponent={<View style={styles.emptyColumn}><Text style={styles.emptyTitle}>{tab==="automations"?"No automation results yet":"You're all caught up"}</Text></View>} renderItem={({item})=>{const outcome=item.automation?automationOutcome(item.automation.status):null;return <Pressable style={[styles.mobileInboxItem,item.read&&styles.mobileInboxRead]} onPress={()=>{void api.markNotificationsRead(item.id);if(item.automation)onOpenResult(item);else if(item.threadId)onOpen(item.threadId)}}><View style={[styles.mobileInboxDot,item.kind==="error"&&styles.mobileInboxDotError,item.kind==="attention"&&styles.mobileInboxDotAttention]}/><View style={styles.categoryCopy}><Text style={styles.automationName}>{item.title}</Text><Text style={styles.automationDescription}>{item.automation?.name||item.message}</Text>{item.automation&&<><Text style={[styles.resultLink,outcome?.tone==="success"?styles.outcomeSuccess:outcome?.tone==="failed"?styles.outcomeFailed:styles.outcomeUnknown]}>{outcome?.label} · Open result</Text><Text numberOfLines={3} style={styles.notificationResultSummary}>{item.automation.result}</Text></>}</View><MobileIcon name="chevron-right" size={18} color={colors.primary}/></Pressable>}} ListFooterComponent={items.length?<Pressable style={styles.moveCancel} onPress={()=>void api.clearNotifications().then(onChanged)}><Text style={styles.deleteAutomation}>Clear all notifications</Text></Pressable>:null}/></SafeAreaView></Modal>;
}

const mobileTourSteps = [["YOUR BOARDS","Projects, separated","Open every project as its own board. Categories still follow your prefixes, while All projects gives you a complete overview."],["REAL CHAT","Continue anywhere","Read history, send instructions, approve commands and answer Codex directly from mobile."],["AUTOMATIONS","Build your routine","Schedule recurring prompts and timed moves that run persistently on your PC."]];
function MobileTour({onDone}:{onDone:()=>void}){const[index,setIndex]=useState(0);const step=mobileTourSteps[index];return <Modal animationType="fade" onRequestClose={onDone}><SafeAreaView style={styles.tourMobile}><View style={styles.tourMobileArt}><View style={styles.mobileLogo}><View style={[styles.logoBar,{height:9}]}/><View style={[styles.logoBar,{height:18}]}/><View style={[styles.logoBar,{height:13}]}/></View><View style={styles.tourMiniBoard}><View style={styles.tourMiniColumn}/><View style={styles.tourMiniColumn}/><View style={styles.tourMiniColumn}/></View></View><View style={styles.tourMobileCopy}><Text style={styles.overviewEyebrow}>{step[0]}</Text><Text style={styles.tourMobileTitle}>{step[1]}</Text><Text style={styles.tourMobileText}>{step[2]}</Text><View style={styles.tourMobileDots}>{mobileTourSteps.map((_,dot)=><View key={dot} style={[styles.tourMobileDot,dot===index&&styles.tourMobileDotActive]}/>)}</View><Pressable style={styles.primaryButton} onPress={()=>index===mobileTourSteps.length-1?onDone():setIndex(index+1)}><Text style={styles.primaryButtonText}>{index===mobileTourSteps.length-1?"Start using Board":"Next"}</Text></Pressable><Pressable style={styles.moveCancel} onPress={onDone}><Text style={styles.moveCancelText}>Skip guide</Text></Pressable></View></SafeAreaView></Modal>}

function RetryAutomationsButton({ api, automations, onChanged }: { api: BoardApi; automations: Automation[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const retryable = automations.filter(item => item.lastResult ? automationOutcome(item.lastResult.status).retryable : Boolean(item.lastError));
  async function retry() { setBusy(true); try { await Promise.all(selected.map(id => api.retryAutomation(id))); setOpen(false); onChanged(); } catch(error) { Alert.alert("Retry failed", error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }
  return <><Pressable style={styles.retryManyButton} disabled={!retryable.length} onPress={()=>{setSelected(retryable.filter(item=>item.runState!=="running").map(item=>item.id));setOpen(true);}}><MobileIcon name="refresh-cw" size={16} color={colors.primary}/><Text style={styles.retryManyText}>Retry automations</Text></Pressable><Modal transparent visible={open} animationType="fade" onRequestClose={()=>!busy&&setOpen(false)}><View style={styles.taskPickerBackdrop}><View style={styles.taskPickerModal}><Text style={styles.managerTitle}>Select workflows to retry</Text><ScrollView>{retryable.map(item=><Pressable key={item.id} style={styles.taskPickerOption} disabled={item.runState==="running"||busy} onPress={()=>setSelected(current=>current.includes(item.id)?current.filter(id=>id!==item.id):[...current,item.id])}><Text style={styles.automationName}>{selected.includes(item.id)?"☑":"□"}  {item.name}{item.runState==="running"?" · Running":""}</Text></Pressable>)}</ScrollView><View style={styles.retryManyActions}><Pressable onPress={()=>setOpen(false)} disabled={busy}><Text style={styles.editButton}>Cancel</Text></Pressable><Pressable onPress={()=>void retry()} disabled={busy||selected.length===0}><Text style={styles.editButton}>{busy?"Queuing…":`Retry ${selected.length}`}</Text></Pressable></View></View></View></Modal></>;
}

function AutomationManager({ api, automations, threads, categories, onClose, onChanged }: { api: BoardApi; automations: Automation[]; threads: ThreadDto[]; categories: string[]; onClose: () => void; onChanged: () => void }) {
  const [editing, setEditing] = useState<Automation | null>(null);
  const [view, setView] = useState<"overview" | "createAutomation" | "createPipeline">("overview");
  const [kind, setKind] = useState<"recurringMessage" | "scheduledMessage" | "calendarMessage">("recurringMessage");
  const [name, setName] = useState("");
  const [threadId, setThreadId] = useState(threads.find(thread => categoryFromTitle(thread.name).toLowerCase() === "schedule")?.id || "");
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [intervalValue, setIntervalValue] = useState("1");
  const [intervalUnit, setIntervalUnit] = useState<"minutes" | "hours" | "days">("hours");
  const recurringMinutes = automationIntervalMinutes(Number.parseInt(intervalValue, 10), intervalUnit);
  const [runAt, setRunAt] = useState("");
  const [time, setTime] = useState("09:00");
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [fromCategory, setFromCategory] = useState(categories[0] || "");
  const [toCategory, setToCategory] = useState(categories[1] || categories[0] || "");
  const [pipelineTiming, setPipelineTiming] = useState<"delay" | "scheduled">("delay");
  const [busy, setBusy] = useState(false);
  function beginCreate(nextView: typeof view) {
    setEditing(null); setName(""); setPrompt(""); setRunAt(""); setView(nextView);
  }
  function edit(automation: Automation) {
    const fields = automationEditFields(automation);
    setEditing(automation); setName(fields.name); setPrompt(fields.prompt); setThreadId(fields.threadId);
    setKind(fields.kind); setIntervalValue(fields.intervalValue); setIntervalUnit(fields.intervalUnit);
    setMinutes(fields.minutes); setRunAt(fields.runAt.replace("T", " ")); setTime(fields.time); setWeekdays(fields.weekdays);
    setFromCategory(fields.fromCategory); setToCategory(fields.toCategory); setPipelineTiming(fields.pipelineTiming);
    setView(fields.pipeline ? "createPipeline" : "createAutomation");
  }
  async function create() {
    const interval = Number.parseInt(minutes, 10);
    let input: CreateAutomationInput;
    if (view === "createPipeline") input = pipelineTiming === "delay"
      ? { name: name.trim(), action: { kind: "categoryPipeline", fromCategory, toCategory, afterMinutes: interval } }
      : { name: name.trim(), action: { kind: "scheduledCategoryPipeline", fromCategory, toCategory, runAt: parseLocalDateTime(runAt) } };
    else if (kind === "recurringMessage") input = { name: name.trim(), action: { kind, threadId, prompt: prompt.trim(), everyMinutes: recurringMinutes, startInMinutes: recurringMinutes } };
    else if (kind === "scheduledMessage") input = { name: name.trim(), action: { kind, threadId, prompt: prompt.trim(), runAt: parseLocalDateTime(runAt) } };
    else { const [hour, minute] = time.split(":").map(Number); input = { name: name.trim(), action: { kind, threadId, prompt: prompt.trim(), weekdays, minuteOfDay: hour * 60 + minute, timezoneOffsetMinutes: new Date().getTimezoneOffset() } }; }
    setBusy(true);
    try { if (editing) await api.updateAutomation(editing.id, automationUpdateInput(input, editing)); else await api.createAutomation(input); setName(""); setPrompt(""); setRunAt(""); onChanged(); setView("overview"); }
    catch (error) { Alert.alert(editing ? "Could not save workflow" : "Could not create automation", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const creatingPipeline = view === "createPipeline";
  const unchangedDate = editing && "runAt" in editing.action && runAt.replace(" ", "T") === automationDateTimeValue(editing.action.runAt);
  const validSchedule = creatingPipeline
    ? pipelineTiming === "delay" ? Number(minutes) >= 1 : (unchangedDate || parseLocalDateTime(runAt) > Date.now())
    : kind === "scheduledMessage" ? (unchangedDate || parseLocalDateTime(runAt) > Date.now()) : kind !== "calendarMessage" || weekdays.length > 0;
  const valid = name.trim() && validSchedule && (creatingPipeline
    ? fromCategory && toCategory && fromCategory !== toCategory
    : threadId && prompt.trim() && (kind !== "recurringMessage" || Number.isInteger(Number(intervalValue)) && Number(intervalValue) >= 1 && Number.isSafeInteger(recurringMinutes) && recurringMinutes <= 525_600));
  return <Modal animationType="slide" onRequestClose={view === "overview" ? onClose : () => setView("overview")}><SafeAreaView style={styles.page}>
    <View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel={view === "overview" ? "Close workflows" : "Back to workflows"} style={styles.chatBackButton} onPress={view === "overview" ? onClose : () => setView("overview")}><MobileIcon name={view === "overview" ? "x" : "chevron-left"} size={24} color={colors.text}/></Pressable><View style={styles.headerCopy}><Text style={styles.headerTitle}>{view === "overview" ? "Workflows" : editing ? creatingPipeline ? "Edit pipeline" : "Edit automation" : creatingPipeline ? "New pipeline" : "New automation"}</Text><Text style={styles.headerMeta}>{view === "overview" ? "Schedules running on your PC" : creatingPipeline ? "Schedule category movement" : "Schedule a Codex prompt"}</Text></View></View>
    {view === "overview" ? <ScrollView contentContainerStyle={styles.manager}>
      <View style={styles.managerIntro}><Text style={styles.overviewEyebrow}>ORCHESTRATION</Text><Text style={styles.managerTitle}>Your workflows</Text><Text style={styles.managerSubtitle}>Automations send prompts. Pipelines move tasks between categories.</Text></View>
      <RetryAutomationsButton api={api} automations={automations} onChanged={onChanged}/>
      <View style={styles.workflowCreateChoices}><Pressable style={styles.workflowCreateCard} onPress={() => beginCreate("createAutomation")}><View style={styles.automationIcon}><MobileIcon name="zap" color={colors.primary}/></View><View style={styles.categoryCopy}><Text style={styles.automationName}>New automation</Text><Text style={styles.automationDescription}>Schedule a prompt for a task</Text></View><MobileIcon name="chevron-right" size={18} color={colors.primary}/></Pressable><Pressable style={styles.workflowCreateCard} onPress={() => beginCreate("createPipeline")}><View style={styles.automationIcon}><MobileIcon name="repeat" color={colors.primary}/></View><View style={styles.categoryCopy}><Text style={styles.automationName}>New pipeline</Text><Text style={styles.automationDescription}>Move tasks after a delay or on a date</Text></View><MobileIcon name="chevron-right" size={18} color={colors.primary}/></Pressable></View>
      {automations.length === 0 && <View style={styles.automationEmpty}><MobileIcon name="zap" size={30} color={colors.primary}/><Text style={styles.emptyTitle}>No workflows yet</Text><Text style={styles.emptyText}>Choose automation or pipeline above to create the first one.</Text></View>}
      {automations.map((automation) => <View key={automation.id} style={styles.automationCard}><View style={styles.automationCardTop}><View style={styles.automationIcon}><MobileIcon name={automation.action.kind === "categoryPipeline" || automation.action.kind === "scheduledCategoryPipeline" ? "repeat" : automation.action.kind === "scheduledMessage" ? "clock" : "repeat"} color={colors.primary}/></View><View style={styles.categoryCopy}><Text style={styles.automationName}>{automation.name}</Text><Text style={styles.automationDescription}>{automationDescription(automation, threads)}</Text>{automation.runState && <Text style={styles.automationDescription}>{automation.runState === "queued" ? "Queued" : "Running"}</Text>}{automation.lastResult ? <><Text style={[styles.automationOutcome, automation.lastResult.status === "success" ? styles.outcomeSuccess : automation.lastResult.status === "failed" ? styles.outcomeFailed : styles.outcomeUnknown]}>{automationOutcome(automation.lastResult.status).label}</Text><Text style={styles.automationDescription}>{automation.lastResult.summary}</Text></> : <Text style={styles.automationDescription}>{automation.lastError || "No verified result yet"}</Text>}</View><Pressable style={[styles.toggle, automation.enabled && styles.toggleOn]} onPress={() => void api.setAutomationEnabled(automation.id, !automation.enabled).then(onChanged)}><View style={[styles.toggleKnob, automation.enabled && styles.toggleKnobOn]} /></Pressable></View><View style={styles.automationEditActions}>{automation.lastResult && automationOutcome(automation.lastResult.status).retryable && <RetryAutomationAction key={automation.lastResult.finishedAt} disabled={automation.runState === "running"} onRetry={()=>api.retryAutomation(automation.id).then(onChanged)}/>}<Pressable accessibilityRole="button" accessibilityLabel={`Edit ${automation.name}`} style={styles.chatBackButton} onPress={() => edit(automation)}><MobileIcon name="edit-2" size={22} color={colors.primary}/></Pressable><Pressable accessibilityRole="button" accessibilityLabel={`Delete ${automation.name}`} style={styles.chatBackButton} onPress={() => Alert.alert("Delete workflow?", automation.name, [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => void api.deleteAutomation(automation.id).then(onChanged) }])}><MobileIcon name="trash-2" size={21} color={colors.danger}/></Pressable></View></View>)}
    </ScrollView> : <ScrollView contentContainerStyle={styles.manager}>
      <View style={styles.managerIntro}><Text style={styles.overviewEyebrow}>{editing ? "EDIT WORKFLOW" : creatingPipeline ? "NEW PIPELINE" : "NEW AUTOMATION"}</Text><Text style={styles.managerTitle}>{creatingPipeline ? "Move work automatically" : "Schedule a Codex prompt"}</Text><Text style={styles.managerSubtitle}>{creatingPipeline ? "Move every task in a category after time spent there or at a specific date." : "Run once, repeat on an interval or use a weekly calendar."}</Text></View>
      <View style={styles.automationComposer}><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.automationModes}>{(creatingPipeline ? [["delay","After time"],["scheduled","Specific date"]] : [["recurringMessage","Interval"],["scheduledMessage","Once"],["calendarMessage","Calendar"]]).map(([value,label])=><Pressable key={value} style={[styles.automationMode,(creatingPipeline ? pipelineTiming===value : kind===value)&&styles.automationModeActive]} onPress={()=>creatingPipeline?setPipelineTiming(value as typeof pipelineTiming):setKind(value as typeof kind)}><Text style={[styles.segmentText,(creatingPipeline ? pipelineTiming===value : kind===value)&&styles.segmentTextActive]}>{label}</Text></Pressable>)}</ScrollView>
        <TextInput style={styles.smallInput} value={name} onChangeText={setName} placeholder={creatingPipeline ? "Pipeline name" : "Automation name"} />
        {!creatingPipeline ? <><Text style={styles.fieldLabel}>SCHEDULE TASK</Text>{threadId && !threads.some(thread => thread.id === threadId && categoryFromTitle(thread.name).toLowerCase() === "schedule") && <Text style={styles.automationDescription}>Current task is outside Schedule. Choose a Schedule task to change the target.</Text>}<Pressable style={styles.taskPickerButton} onPress={()=>setTaskPickerOpen(true)}><Text numberOfLines={1} style={styles.taskPickerButtonText}>{displayTitle(threads.find(thread=>thread.id===threadId)?.name,threads.find(thread=>thread.id===threadId)?.preview)||"Choose a Schedule task"}</Text><MobileIcon name="chevron-down" size={18} color={colors.textMuted}/></Pressable><Modal transparent visible={taskPickerOpen} animationType="fade" onRequestClose={()=>setTaskPickerOpen(false)}><Pressable style={styles.taskPickerBackdrop} onPress={()=>setTaskPickerOpen(false)}><View style={styles.taskPickerModal}><Text style={styles.managerTitle}>Choose a Schedule task</Text><ScrollView>{threads.filter(thread=>categoryFromTitle(thread.name).toLowerCase()==="schedule").map(thread=><Pressable key={thread.id} style={styles.taskPickerOption} onPress={()=>{setThreadId(thread.id);setTaskPickerOpen(false);}}><Text style={styles.automationName}>{displayTitle(thread.name,thread.preview)}</Text><Text style={styles.automationDescription}>{thread.cwd||"Project"}</Text></Pressable>)}</ScrollView></View></Pressable></Modal><TextInput style={[styles.smallInput, styles.promptInput]} value={prompt} onChangeText={setPrompt} multiline placeholder="What should Codex do?" /></> : <><Text style={styles.fieldLabel}>FROM CATEGORY</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.miniChoices}>{[...new Set([...categories, fromCategory, toCategory].filter(Boolean))].map((category) => <Pressable key={category} style={[styles.miniChoice, category === fromCategory && styles.miniChoiceActive]} onPress={() => setFromCategory(category)}><Text style={[styles.miniChoiceText, category === fromCategory && styles.miniChoiceTextActive]}>{category}</Text></Pressable>)}</ScrollView><Text style={styles.fieldLabel}>TO CATEGORY</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.miniChoices}>{[...new Set([...categories, fromCategory, toCategory].filter(Boolean))].map((category) => <Pressable key={category} style={[styles.miniChoice, category === toCategory && styles.miniChoiceActive]} onPress={() => setToCategory(category)}><Text style={[styles.miniChoiceText, category === toCategory && styles.miniChoiceTextActive]}>{category}</Text></Pressable>)}</ScrollView></>}
        {creatingPipeline && pipelineTiming === "delay" && <><Text style={styles.fieldLabel}>MOVE AFTER (MINUTES)</Text><TextInput style={styles.smallInput} value={minutes} onChangeText={setMinutes} keyboardType="number-pad" /></>}
        {!creatingPipeline && kind === "recurringMessage" && <><Text style={styles.fieldLabel}>REPEAT EVERY</Text><TextInput style={styles.smallInput} value={intervalValue} onChangeText={setIntervalValue} keyboardType="number-pad" /><View style={styles.automationModes}>{([["minutes", "min"], ["hours", "hours"], ["days", "days"]] as const).map(([value, label]) => <Pressable key={value} style={[styles.automationMode, intervalUnit === value && styles.automationModeActive]} onPress={() => setIntervalUnit(value)}><Text style={[styles.segmentText, intervalUnit === value && styles.segmentTextActive]}>{label}</Text></Pressable>)}</View></>}
        {creatingPipeline && pipelineTiming === "scheduled" && <><Text style={styles.fieldLabel}>MOVE ON (YYYY-MM-DD HH:MM)</Text><TextInput style={styles.smallInput} value={runAt} onChangeText={setRunAt} placeholder="2026-08-14 09:30" /></>}
        {!creatingPipeline && kind === "scheduledMessage" && <><Text style={styles.fieldLabel}>RUN ONCE (YYYY-MM-DD HH:MM)</Text><TextInput style={styles.smallInput} value={runAt} onChangeText={setRunAt} placeholder="2026-08-14 09:30" /></>}
        {!creatingPipeline && kind === "calendarMessage" && <><Text style={styles.fieldLabel}>TIME (HH:MM)</Text><TextInput style={styles.smallInput} value={time} onChangeText={setTime} placeholder="09:00" keyboardType="numbers-and-punctuation" /><View style={styles.mobileWeekdays}>{[[1,"M"],[2,"T"],[3,"W"],[4,"T"],[5,"F"],[6,"S"],[0,"S"]].map(([day,label])=><Pressable key={day} style={[styles.mobileWeekday,weekdays.includes(day as number)&&styles.miniChoiceActive]} onPress={()=>setWeekdays(current=>current.includes(day as number)?current.filter(value=>value!==day):[...current,day as number])}><Text style={styles.miniChoiceText}>{label}</Text></Pressable>)}</View></>}
        {editing && <Text style={styles.automationDescription}>Changes apply to future runs. Queued or running work is unchanged. Paused workflows stay paused.</Text>}
        {editing?.action.kind === "calendarMessage" && kind === "calendarMessage" && <Text style={styles.automationDescription}>Calendar timezone: UTC{editing.action.timezoneOffsetMinutes <= 0 ? "+" : "−"}{Math.abs(editing.action.timezoneOffsetMinutes) / 60}</Text>}
        <Pressable disabled={!valid || busy} style={[styles.primaryButton, (!valid || busy) && styles.disabled]} onPress={() => void create()}>{busy ? <ActivityIndicator color="white" /> : <Text style={styles.primaryButtonText}>{editing ? "Save changes" : creatingPipeline ? "Create pipeline" : "Create automation"}</Text>}</Pressable>
      </View>
    </ScrollView>}
  </SafeAreaView></Modal>;
}

function Board({ credential, onDisconnect, onOpenTour }: { credential: PairingCredential; onDisconnect: () => Promise<void>; onOpenTour: () => void }) {
  const api = useMemo(() => new BoardApi(credential), [credential]);
  const drafts = useMemo(() => createMobileDrafts(credential.baseUrl), [credential.baseUrl]);
  const preferences = useMemo(() => new TurnSettingsSync(patch=>api.updateTurnSettings(patch)), [api]);
  const [threads, setThreads] = useState<ThreadDto[]>([]);
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});
  const queueRevision = useRef(0);
  const [requests, setRequests] = useState<PendingRemoteRequest[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [notifications, setNotifications] = useState<BoardNotification[]>([]);
  const [automationAlert, setAutomationAlert] = useState<BoardNotification | null>(null);
  const [resultNotification, setResultNotification] = useState<BoardNotification | null>(null);
  const [selected, setSelected] = useState<ThreadDto | null>(null);
  const [managing, setManaging] = useState(false);
  const [moving, setMoving] = useState<ThreadDto | null>(null);
  const [forking, setForking] = useState<ThreadDto | null>(null);
  const [renaming, setRenaming] = useState<ThreadDto | null>(null);
  const [automating, setAutomating] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxInitialTab, setInboxInitialTab] = useState<"notifications" | "automations">("notifications");
  const [selectedProject, setSelectedProject] = useState(ALL_PROJECTS);
  const [boardRestored, setBoardRestored] = useState(false);
  const projectSelectionChanged = useRef(false);
  const [search, setSearch] = useState("");
  const [connected, setConnected] = useState(false);
  const [rateLimits, setRateLimits] = useState<JsonValue | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [eventRevision, setEventRevision] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notificationIds = useRef<Set<string> | null>(null);
  const pendingCreatedThreads = useRef(new Map<string, ThreadDto>());
  const refreshInFlight = useRef(false);
  const refreshAgain = useRef(false);
  const refresh = useCallback(async (): Promise<void> => {
    if (refreshInFlight.current) { refreshAgain.current = true; return; }
    refreshInFlight.current = true;
    const requestedQueueRevision = queueRevision.current;
    try {
      const [nextThreads, nextConfig, nextQueues, nextRequests, nextAutomations, nextNotifications, nextRateLimits] = await Promise.all([api.threads(), api.board().then(shared=>{preferences.receive(shared);return shared;}), api.queues(), api.requests(), api.automations().catch(() => []), api.notifications().catch(() => []), api.rateLimits().catch(() => null)]);
      const fetchedIds = new Set(nextThreads.map((thread) => thread.id));
      for (const id of fetchedIds) pendingCreatedThreads.current.delete(id);
      const mergedThreads = [...nextThreads, ...[...pendingCreatedThreads.current].filter(([id]) => !fetchedIds.has(id)).map(([, thread]) => thread)];
      const projects = [...(nextConfig.projects || [])];
      for (const thread of mergedThreads) if (thread.cwd && !projects.some((cwd) => projectKey(cwd) === projectKey(thread.cwd))) projects.push(thread.cwd);
      const resolvedConfig = projects.length === (nextConfig.projects || []).length ? nextConfig : await api.updateBoard({ ...nextConfig, projects });
      preferences.receive(resolvedConfig);
      setThreads(mergedThreads); setConfig(current=>current&&current.revision>resolvedConfig.revision?current:resolvedConfig); if (queueRevision.current === requestedQueueRevision) setQueues(nextQueues); setRequests(nextRequests); setAutomations(nextAutomations); setNotifications(nextNotifications);
      setConnectionError(null);
      setRateLimits(nextRateLimits);
      const known = notificationIds.current;
      if (known) {
        const fresh = nextNotifications.find((item) => item.automation && !known.has(item.id));
        if (fresh) {
          setAutomationAlert(fresh);
          setTimeout(() => setAutomationAlert((current) => current?.id === fresh.id ? null : current), 10_000);
        }
      }
      notificationIds.current = new Set(nextNotifications.map((item) => item.id));
    } catch (error) { setConnectionError(error instanceof Error ? error.message : String(error)); if (!preferences.getSnapshot().ready) preferences.unavailable(error); }
    finally {
      refreshInFlight.current = false;
      setLoading(false); setRefreshing(false);
      if (refreshAgain.current) { refreshAgain.current = false; void refresh(); }
    }
  }, [api, preferences]);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      setEventRevision((value) => value + 1);
      void refresh();
    }, 250);
  }, [refresh]);
  const markQueueChanged = useCallback(() => { queueRevision.current += 1; }, []);
  useEffect(() => {
    void refresh();
    const unsubscribe = api.subscribe(event=>{
      if (event.method === "board/queue/updated") {
        const value = object(event.params);
        if (typeof value.threadId === "string" && Array.isArray(value.messages)) {
          queueRevision.current += 1;
          setQueues(current => ({ ...current, [value.threadId as string]: value.messages as unknown as QueuedMessage[] }));
        }
      }
      if(event.method==="board/config/updated") {
        const value=object(event.params);
        if(typeof value.revision==="number"&&value.turnSettings&&typeof value.turnSettings==="object") {
          const shared=value as unknown as BoardConfig;
          preferences.receive(shared);
          setConfig(current=>current&&current.revision>shared.revision?current:shared);
        }
      }
      scheduleRefresh();
    }, (online)=>{setConnected(online);if(online)scheduleRefresh();});
    const foreground = AppState.addEventListener("change", state=>{if(state==="active")scheduleRefresh();});
    return () => {
      unsubscribe();
      foreground.remove();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [api, preferences, refresh, scheduleRefresh]);
  useEffect(() => {
    void loadSelectedBoard().then(saved=>{if(saved&&!projectSelectionChanged.current)setSelectedProject(saved);})
      .catch(()=>undefined).finally(()=>setBoardRestored(true));
  }, []);
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (selected) { setSelected(null); return true; }
      if (projectOpen) { setProjectOpen(false); return true; }
      return false;
    });
    return () => subscription.remove();
  }, [projectOpen, selected]);
  const discovered = [...new Set(threads.map((thread) => categoryFromTitle(thread.name)))];
  const categories = [...(config?.categories || []), ...discovered.filter((value) => !config?.categories.includes(value))];
  const projects = useMemo(() => projectBoards(threads, config?.projects || []), [config?.projects, threads]);
  const projectThreads = selectedProject === ALL_PROJECTS ? threads : threads.filter((thread) => projectKey(thread.cwd) === selectedProject);
  const dashboardCategories = categories.filter((category) => projectThreads.some((thread) => categoryFromTitle(thread.name) === category));
  useEffect(() => { if (config && boardRestored && !loading && selectedProject !== ALL_PROJECTS && !projects.some((project) => project.key === selectedProject)) { setSelectedProject(ALL_PROJECTS); void saveSelectedBoard(ALL_PROJECTS); } }, [config, boardRestored, loading, selectedProject, projects]);
  useEffect(() => {
    if (dashboardCategories.length > 0 && (!activeCategory || !dashboardCategories.includes(activeCategory))) setActiveCategory(dashboardCategories[0]);
  }, [activeCategory, dashboardCategories.join("\u0000")]);
  const visibleCategory = activeCategory && dashboardCategories.includes(activeCategory) ? activeCategory : dashboardCategories[0];
  const visibleThreads = projectThreads.filter((thread) => categoryFromTitle(thread.name) === visibleCategory);
  const searchedThreads = (search.trim() ? projectThreads : visibleThreads).filter((thread) => {
    const query = search.trim().toLocaleLowerCase();
    return !query || [displayTitle(thread.name, thread.preview), thread.preview || "", projectLabel(thread.cwd)].some((value) => value.toLocaleLowerCase().includes(query));
  }).sort((left,right)=>(right.updatedAt||0)-(left.updatedAt||0));
  const workingCount = projectThreads.filter(isWorking).length;
  const selectedProjectLabel = selectedProject === ALL_PROJECTS ? "All projects" : projects.find((project) => project.key === selectedProject)?.label || "Project";
  async function archiveThread(thread: ThreadDto) {
    const title = displayTitle(thread.name, thread.preview);
    Alert.alert("Archive task", `Archive “${title}”?`, [{ text: "Cancel", style: "cancel" }, { text: "Archive", style: "destructive", onPress: () => void api.archive(thread.id).then(() => { if (selected?.id === thread.id) setSelected(null); return refresh(); }).catch((error) => Alert.alert("Could not archive task", String(error))) }]);
  }
  async function archiveProject(project: { key: string; label: string }) {
    const items = threads.filter((thread) => projectKey(thread.cwd) === project.key);
    if (items.length === 0) { Alert.alert("Empty project", "This project has no conversations and will remain available."); return; }
    Alert.alert("Archive project", `Archive ${items.length} tasks from “${project.label}”?`, [{ text: "Cancel", style: "cancel" }, { text: "Archive", style: "destructive", onPress: () => void Promise.all(items.map((thread) => api.archive(thread.id))).then(() => { setProjectOpen(false); setSelectedProject(ALL_PROJECTS); return refresh(); }).catch((error) => Alert.alert("Could not archive project", String(error))) }]);
  }
  async function stopThread(thread: ThreadDto) {
    try { const loaded = await api.thread(thread.id); const turnId = activeTurnId(loaded); if (turnId) await api.interrupt(thread.id, turnId); else Alert.alert("Thread changed", "The active turn is no longer available."); await refresh(); }
    catch (error) { Alert.alert("Could not stop task", error instanceof Error ? error.message : String(error)); }
  }
  function selectProjectBoard(key: string) {
    projectSelectionChanged.current = true;
    setSelectedProject(key);
    setProjectOpen(true);
    setSearch("");
    setActiveCategory(null);
    void saveSelectedBoard(key);
  }

  function retainCreatedThread(thread: ThreadDto) {
    pendingCreatedThreads.current.set(thread.id, thread);
    setThreads((current) => current.some((item) => item.id === thread.id) ? current : [thread, ...current]);
    openThread(thread);
  }

  function openThread(thread: ThreadDto) {
    selectProjectBoard(projectKey(thread.cwd));
    setActiveCategory(categoryFromTitle(thread.name));
    setSelected(thread);
  }

  function pullToRefresh() { setRefreshing(true); void refresh(); }

  return <SafeAreaView style={styles.page}>
    {connectionError&&<Pressable style={styles.connectionBanner} onPress={()=>void refresh()} accessibilityRole="button" accessibilityLabel="Retry connection"><Text style={styles.connectionBannerText}>PC unavailable · Tap to retry</Text></Pressable>}
    {selected ? <Chat drafts={drafts} key={selected.id} thread={selected} api={api} queue={queues[selected.id] || []} requests={requests.filter((request) => requestThreadId(request) === selected.id)} eventRevision={eventRevision} preferences={preferences} onClose={() => setSelected(null)} onChanged={refresh} onQueueChanged={markQueueChanged} onFork={() => setForking(selected)} onRename={()=>setRenaming(selected)} /> : <>
    {!projectOpen ? <ProjectHome
      connected={connected}
      loading={loading}
      refreshing={refreshing}
      projects={projects}
      totalCount={threads.length}
      lastProject={selectedProject}
      usage={usageSnapshot(rateLimits)}
      onOpen={selectProjectBoard}
      onArchive={archiveProject}
      onCreate={()=>setCreatingProject(true)}
      onRefresh={pullToRefresh}
    /> : <MobileBoardHome
      connected={connected}
      loading={loading}
      refreshing={refreshing}
      projectLabel={selectedProjectLabel}
      showProject={selectedProject === ALL_PROJECTS}
      totalCount={projectThreads.length}
      workingCount={workingCount}
      categories={dashboardCategories.map(category=>({name:category,count:projectThreads.filter(thread=>categoryFromTitle(thread.name)===category).length}))}
      activeCategory={visibleCategory||""}
      threads={searchedThreads}
      queues={queues}
      search={search}
      isWorking={isWorking}
      titleFor={(thread)=>displayTitle(thread.name,thread.preview)}
      projectFor={(thread)=>projectLabel(thread.cwd)}
      onSearch={setSearch}
      onBackToProjects={()=>setProjectOpen(false)}
      onCategory={setActiveCategory}
      onOpen={setSelected}
      onMove={setMoving}
      onFork={setForking}
      onRename={setRenaming}
      onArchive={archiveThread}
      onStop={stopThread}
      onNewTask={()=>setCreatingTask(true)}
      onRefresh={pullToRefresh}
    />}
    <MobileNavigation unreadCount={notifications.filter(item=>!item.read).length} onProjects={()=>setProjectOpen(false)} onInbox={()=>{setInboxInitialTab("notifications");setInboxOpen(true)}} onAutomations={()=>setAutomating(true)} onSettings={()=>setManaging(true)}/>
    </>}
    {automationAlert&&<Pressable style={styles.mobileAutomationAlert} onPress={()=>{setAutomationAlert(null);setResultNotification(automationAlert);void api.markNotificationsRead(automationAlert.id)}}><View style={styles.mobileAutomationAlertIcon}><MobileIcon name="zap" size={18} color={colors.primary}/></View><View style={styles.categoryCopy}><Text style={styles.automationName}>{automationOutcome(automationAlert.automation?.status).label}</Text><Text style={styles.automationDescription}>{automationAlert.automation?.name}</Text></View><MobileIcon name="chevron-right" size={18} color={colors.primary}/></Pressable>}
    {managing && config && <CategoryManager config={config} threads={threads} api={api} onClose={() => setManaging(false)} onSaved={refresh} onOpenTour={onOpenTour} onDisconnect={() => void onDisconnect()} />}
    {automating && <AutomationManager api={api} automations={automations} threads={threads} categories={categories} onClose={() => setAutomating(false)} onChanged={refresh} />}
    {creatingProject&&config&&<NewProjectModal config={config} api={api} onClose={()=>setCreatingProject(false)} onCreated={(cwd)=>{setCreatingProject(false);selectProjectBoard(projectKey(cwd));void refresh()}}/>}
    {creatingTask && <NewTaskModal api={api} threads={threads} projects={config?.projects || []} categories={categories} defaultProjectKey={selectedProject === ALL_PROJECTS ? undefined : selectedProject} onClose={() => setCreatingTask(false)} onCreated={(thread) => { setCreatingTask(false); retainCreatedThread(thread); void refresh(); }} />}
    {inboxOpen && <InboxModal api={api} items={notifications} initialTab={inboxInitialTab} onClose={()=>setInboxOpen(false)} onChanged={refresh} onOpenResult={(item)=>{setInboxOpen(false);setResultNotification(item)}} onOpen={(id)=>{const thread=threads.find(item=>item.id===id);if(thread){setInboxOpen(false);openThread(thread)}}}/>}
    {moving && <MoveDialog thread={moving} categories={categories} api={api} onClose={() => setMoving(null)} onMoved={refresh} />}
    {forking && <ForkThreadModal api={api} thread={forking} categories={categories} onClose={()=>setForking(null)} onCreated={(thread)=>{setForking(null);openThread(thread);void refresh()}}/>}
    {renaming&&<RenameThreadModal key={renaming.id} api={api} thread={renaming} onClose={()=>setRenaming(null)} onSaved={(saved)=>{setThreads(current=>current.map(item=>item.id===saved.id?saved:item));setSelected(current=>current?.id===saved.id?saved:current);setRenaming(null);void refresh()}}/>}
    {resultNotification&&<AutomationResultModal onRetry={()=>api.retryAutomation(resultNotification.automation!.id).then(refresh)} notification={resultNotification} onClose={()=>setResultNotification(null)} onBackToList={()=>{setResultNotification(null);setInboxInitialTab("automations");setInboxOpen(true)}} onOpenThread={(id)=>{const thread=threads.find(item=>item.id===id);setResultNotification(null);if(thread)openThread(thread)}}/>}
  </SafeAreaView>;
}

function Root() {
  const [credential, setCredential] = useState<PairingCredential | null | undefined>(undefined);
  const [showTour, setShowTour] = useState(false);
  useEffect(() => { void Promise.all([loadCredential(),hasSeenTour()]).then(([saved,seen])=>{setCredential(saved);setShowTour(Boolean(saved&&!seen));}); }, []);
  async function pair(next: PairingCredential) { await new BoardApi(next).health(); await saveCredential(next); setCredential(next); setShowTour(true); }
  async function disconnect() { await clearCredential(); setCredential(null); }
  if (credential === undefined) return <View style={styles.center}><ActivityIndicator /></View>;
  return <><StatusBar style="dark" />{credential ? <Board credential={credential} onDisconnect={disconnect} onOpenTour={() => setShowTour(true)} /> : <PairScreen onPair={pair} />}{showTour&&<MobileTour onDone={()=>{void markTourSeen();setShowTour(false)}}/>}</>;
}

export default function App() { return <SafeAreaProvider><Root /></SafeAreaProvider>; }

const styles = StyleSheet.create({
  workModeRow: { minHeight: 34, marginBottom: 5, flexDirection: "row", alignItems: "center", gap: 6 }, workModeLabel: { marginRight: 3, color: "#8A8F9B", fontSize: 8, fontWeight: "800", letterSpacing: 1 }, workModeButton: { minWidth: 62, height: 28, paddingHorizontal: 10, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 9, backgroundColor: "#FAFAFC" }, workModeButtonActive: { borderColor: "#8588EC", backgroundColor: "#EEEFFF" }, workModeText: { color: "#696E7B", fontSize: 10, fontWeight: "700" }, workModeTextActive: { color: "#5559D8" },
  taskPickerButton: { minHeight: 44, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 11, backgroundColor: "white" }, taskPickerButtonText: { flex: 1, marginRight: 10, color: "#292C36", fontSize: 12, fontWeight: "600" }, taskPickerBackdrop: { flex: 1, padding: 20, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(20,22,30,.45)" }, taskPickerModal: { width: "100%", maxWidth: 460, maxHeight: "75%", padding: 18, borderRadius: 18, backgroundColor: "white" }, taskPickerOption: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#ECEEF2" }, retryManyButton: { minHeight: 42, marginVertical: 10, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", alignSelf: "flex-end", gap: 8, borderWidth: 1, borderColor: "#DADCF2", borderRadius: 11, backgroundColor: "white" }, retryManyText: { color: "#5559D8", fontSize: 11, fontWeight: "700" }, retryManyActions: { marginTop: 14, flexDirection: "row", justifyContent: "flex-end", gap: 20 },
  connectionBanner: { minHeight: 40, paddingHorizontal: 16, justifyContent: "center", backgroundColor: "#FFF0ED" },
  connectionBannerText: { color: "#A4493D", fontSize: 12, fontWeight: "600" },
  activityCard: { marginVertical: 5, borderWidth: 1, borderColor: "#E1E3EA", borderRadius: 14, backgroundColor: "#F8F9FC", overflow: "hidden" },
  activityToggle: { minHeight: 48, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 9 },
  activityTitle: { flex: 1, minWidth: 0, fontSize: 12, color: "#717684", fontWeight: "600" },
  activityBody: { paddingHorizontal: 12, paddingBottom: 12 },
  catalogRetry: { minHeight: 48, padding: 12, justifyContent: "center", borderRadius: 12, backgroundColor: "#FFF0ED", marginBottom: 12 },
  catalogRetryText: { color: "#A4493D", fontSize: 13 },
  page: { flex: 1, backgroundColor: "#F4F5F9" }, center: { flex: 1, alignItems: "center", justifyContent: "center" },
  pairPage: { flex: 1, padding: 24, justifyContent: "center", backgroundColor: "#F4F5F9" }, pairHero: { alignItems: "center", marginBottom: 22 }, pairCard: { padding: 18, borderWidth: 1, borderColor: "#E1E3EB", borderRadius: 20, backgroundColor: "white", shadowColor: "#171923", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.07, shadowRadius: 20, elevation: 3 }, logo: { width: 58, height: 58, borderRadius: 17, backgroundColor: "#1B1E2B", flexDirection: "row", alignItems: "flex-end", gap: 4, padding: 13, alignSelf: "center" }, logoBar: { flex: 1, borderRadius: 2, backgroundColor: "white" },
  pairEyebrow: { marginTop: 19, color: "#6266EA", fontSize: 9, fontWeight: "800", letterSpacing: 1.4 }, pairFootnote: { marginTop: 16, textAlign: "center", color: "#8A8F9C", fontSize: 10, lineHeight: 15 }, connectButton: { marginTop: 10 },
  title: { marginTop: 20, textAlign: "center", fontSize: 30, fontWeight: "800", letterSpacing: -1, color: "#171923" }, subtitle: { marginVertical: 12, textAlign: "center", color: "#747987", fontSize: 14, lineHeight: 21 }, or: { margin: 16, textAlign: "center", color: "#969BA7", fontSize: 11, fontWeight: "600" },
  primaryButton: { minHeight: 52, marginTop: 12, borderRadius: 14, backgroundColor: "#6266EA", alignItems: "center", justifyContent: "center", paddingHorizontal: 18 }, compactButton: { minHeight: 42 }, primaryButtonText: { color: "white", fontWeight: "700" }, secondaryButton: { minHeight: 46, borderRadius: 12, backgroundColor: "white", alignItems: "center", justifyContent: "center", paddingHorizontal: 22 }, disabled: { opacity: 0.45 },
  input: { minHeight: 82, borderWidth: 1, borderColor: "#d7d9df", borderRadius: 12, padding: 12, backgroundColor: "white", textAlignVertical: "top" }, smallInput: { minHeight: 42, borderWidth: 1, borderColor: "#d7d9df", borderRadius: 9, padding: 10, backgroundColor: "white" },
  scanner: { flex: 1, backgroundColor: "black" }, scannerOverlay: { flex: 1, alignItems: "center", justifyContent: "space-between", padding: 28 }, scannerTitle: { color: "white", fontSize: 20, fontWeight: "700" }, scanFrame: { width: 250, height: 250, borderWidth: 3, borderColor: "white", borderRadius: 22 },
  header: { minHeight: 70, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: "#DFE1E8", backgroundColor: "white" }, headerCopy: { flex: 1, minWidth: 0 }, headerTitle: { flexShrink: 1, color: "#171923", fontSize: 17, fontWeight: "800", letterSpacing: -0.35 }, headerMeta: { marginTop: 3, color: "#858A96", fontSize: 10 }, headerAction: { color: "#6266EA", fontSize: 12, fontWeight: "700" }, back: { color: "#6266EA", fontSize: 20, lineHeight: 20, includeFontPadding: false, textAlignVertical: "center" }, stop: { color: "#B6473A", fontSize: 11, fontWeight: "800" }, topbarActions:{flexDirection:"row",alignItems:"center",gap:7},topbarIconButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 12, borderWidth: 1, borderColor: "#E1E3EA", backgroundColor: "#FAFAFC" }, topbarForkIcon:{color:"#6266EA",fontSize:21,lineHeight:22},topbarIconDanger: { borderColor: "#F0D5D1", backgroundColor: "#FFF0ED" }, stopIcon: { color: "#B6473A", fontSize: 12 }, readAllIcon: { color: "#6266EA", fontSize: 13, fontWeight: "800", letterSpacing: -3 },
  columns: { padding: 14, gap: 12 }, column: { width: 310, borderRadius: 14, backgroundColor: "#e9ebef", padding: 10 }, columnHeader: { height: 42, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4 }, columnTitle: { color: "#31343b", fontSize: 13, fontWeight: "700" }, count: { color: "#777d88", backgroundColor: "white", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, fontSize: 11 },
  card: { marginBottom: 13, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: "#E2E4EC", backgroundColor: "white", shadowColor: "#171923", shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.06, shadowRadius: 14, elevation: 2 }, workingCard: { borderColor: "#9295F2", borderLeftWidth: 4 }, cardTitle: { color: "#171923", fontSize: 17, lineHeight: 22, fontWeight: "700", letterSpacing: -0.3 }, cardPreview: { marginTop: 8, color: "#747987", fontSize: 13, lineHeight: 19 }, cardStatus: { color: "#6266EA", fontSize: 11, fontWeight: "700" }, workingText: { color: "#6266EA" }, empty: { textAlign: "center", color: "#777", marginTop: 50 },
  chat: { flex: 1 }, chatContent: { padding: 16, paddingBottom: 22, gap: 11 }, bubble: { maxWidth: "90%", borderRadius: 17, paddingHorizontal: 15, paddingVertical: 12 }, bubble_user: { alignSelf: "flex-end", backgroundColor: "#6266EA", borderBottomRightRadius: 5 }, bubble_assistant: { alignSelf: "flex-start", backgroundColor: "white", borderBottomLeftRadius: 5, borderWidth: 1, borderColor: "#E4E6ED" }, bubble_activity: { alignSelf: "stretch", maxWidth: "100%", backgroundColor: "#ECEEF4", borderRadius: 12 }, bubbleLabel: { marginBottom: 7, color: "#858A96", fontSize: 8, fontWeight: "800", letterSpacing: 1 }, bubbleText: { color: "#252832", fontSize: 14, lineHeight: 21 }, userText: { color: "white" }, generatedImage: { width: 280, height: 260, backgroundColor: "#F1F2F6", borderRadius: 12 }, imageCaption: { marginTop: 8, color: "#555B68", fontSize: 12, lineHeight: 18 },
  activityHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, activityStatus: { marginBottom: 7, color: "#7378D8", fontSize: 8, fontWeight: "800" },
  composer: { flexDirection: "row", gap: 9, alignItems: "flex-end", padding: 11, borderTopWidth: StyleSheet.hairlineWidth, borderColor: "#DFE1E8", backgroundColor: "white" }, composerInput: { width: "100%", maxHeight: 120, minHeight: 46, padding: 11, borderWidth: 0, borderRadius: 12, backgroundColor: "white", textAlignVertical: "top" }, send: { minHeight: 42, minWidth: 68, paddingHorizontal: 14, borderRadius: 11, backgroundColor: "#6266EA", alignItems: "center", justifyContent: "center" },
  queueBox: { marginTop: 10, padding: 12, borderRadius: 10, backgroundColor: "#eef0ff" }, queueRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: "#ccd1ee" }, queueIndex: { color: "#5869df", fontWeight: "700" }, queueText: { flex: 1, fontSize: 12, lineHeight: 17 }, remove: { fontSize: 20, color: "#777" },
  requestCard: { marginTop: 12, padding: 14, borderRadius: 11, borderWidth: 1, borderColor: "#8792e8", backgroundColor: "white" }, requestTitle: { fontSize: 13, fontWeight: "700" }, requestText: { marginTop: 6, color: "#666", fontSize: 12, lineHeight: 17 }, command: { marginTop: 8, padding: 9, borderRadius: 7, backgroundColor: "#22252b", color: "white", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 11 }, requestActions: { marginTop: 12, flexDirection: "row", flexWrap: "wrap", gap: 7 }, denyButton: { minHeight: 38, paddingHorizontal: 12, borderRadius: 8, backgroundColor: "#e7e8eb", alignItems: "center", justifyContent: "center" }, allowButton: { minHeight: 38, paddingHorizontal: 12, borderRadius: 8, backgroundColor: "#5869df", alignItems: "center", justifyContent: "center" }, question: { marginTop: 10 }, questionText: { marginBottom: 7, fontSize: 12, fontWeight: "600" }, option: { marginTop: 6, padding: 10, borderWidth: 1, borderColor: "#dddfe5", borderRadius: 8 }, optionSelected: { borderColor: "#5869df", backgroundColor: "#eef0ff" }, optionDescription: { marginTop: 3, color: "#777", fontSize: 10 },
  manager: { padding: 16, paddingBottom: 30 }, closeIcon: { color: "#6266EA", fontSize: 24, lineHeight: 26, fontWeight: "400" }, managerIntro: { padding: 6, marginBottom: 16 }, managerTitle: { marginTop: 5, color: "#171923", fontSize: 25, fontWeight: "800", letterSpacing: -0.8 }, managerSubtitle: { marginTop: 7, color: "#7B808D", fontSize: 12, lineHeight: 18 }, addRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16 }, categoryRow: { minHeight: 66, marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 13, paddingVertical: 10, borderWidth: 1, borderColor: "#E2E4EC", borderRadius: 13, backgroundColor: "white" }, categoryCopy: { flex: 1 }, orderButton: { fontSize: 21, color: "#6266EA" }, editButton: { color: "#6266EA", fontSize: 11, fontWeight: "700" }, deleteButton: { color: "#B54A3C", fontSize: 11, fontWeight: "700" },
  modeRow: { marginBottom: 16, padding: 12, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 10, backgroundColor: "white" }, moveLink: { alignSelf: "flex-end", marginTop: 8, padding: 4 }, modalBackdrop: { flex: 1, padding: 16, justifyContent: "flex-end", backgroundColor: "rgba(18,20,27,.48)" }, moveDialog: { maxHeight: "82%", padding: 20, paddingTop: 10, borderRadius: 24, backgroundColor: "#F8F8FB" }, sheetHandle: { width: 38, height: 4, marginBottom: 20, alignSelf: "center", borderRadius: 2, backgroundColor: "#D3D5DD" }, moveEyebrow: { color: "#6266EA", fontSize: 9, fontWeight: "800", letterSpacing: 1.2 }, moveTitle: { marginTop: 6, color: "#171923", fontSize: 22, lineHeight: 28, fontWeight: "800", letterSpacing: -0.6 }, moveSubtitle: { marginTop: 5, marginBottom: 17, color: "#7C818E", fontSize: 12 }, moveOptions: { maxHeight: 390 }, moveOption: { minHeight: 58, marginBottom: 8, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 11, borderWidth: 1, borderColor: "#E1E3EA", borderRadius: 14, backgroundColor: "white" }, moveOptionSelected: { borderColor: "#D8DAE5", backgroundColor: "#EEEFF4" }, categoryDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: "#8E91ED" }, categoryDotSelected: { backgroundColor: "#A7ABB6" }, moveOptionText: { flex: 1, color: "#242630", fontSize: 14, fontWeight: "700" }, moveOptionTextSelected: { color: "#7B808D" }, currentLabel: { color: "#9296A2", fontSize: 8, fontWeight: "800", letterSpacing: 0.8 }, moveChevron: { color: "#6266EA", fontSize: 25 }, moveCancel: { minHeight: 48, marginTop: 8, alignItems: "center", justifyContent: "center" }, moveCancelText: { color: "#666B78", fontSize: 13, fontWeight: "700" },
  mobileHeader: { minHeight: 72, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "white", borderBottomWidth: StyleSheet.hairlineWidth, borderColor: "#E3E5EC" },
  mobileBrand: { flexDirection: "row", alignItems: "center", gap: 11 }, mobileLogo: { width: 38, height: 38, padding: 9, borderRadius: 11, flexDirection: "row", alignItems: "flex-end", gap: 3, backgroundColor: "#1B1E2B" }, mobileTitle: { color: "#171923", fontSize: 17, fontWeight: "800", letterSpacing: -0.4 }, connectionText: { marginTop: 2, color: "#7A7F8D", fontSize: 10, fontWeight: "600" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 7 }, iconAction: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 11, borderWidth: 1, borderColor: "#E2E4EB", backgroundColor: "#FAFAFC" }, iconActionText: { color: "#5F6471", fontSize: 16 }, automationActionText: { color: "#6266EA", fontSize: 15 }, avatarAction: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 18, backgroundColor: "#ECEEFF" }, avatarText: { color: "#6266EA", fontSize: 10, fontWeight: "800" },
  mobileOverview: { paddingHorizontal: 20, paddingTop: 22, paddingBottom: 15, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, overviewEyebrow: { color: "#6266EA", fontSize: 9, fontWeight: "800", letterSpacing: 1.2 }, overviewTitle: { marginTop: 5, color: "#171923", fontSize: 24, lineHeight: 29, fontWeight: "800", letterSpacing: -0.8 }, liveMetric: { minWidth: 60, paddingVertical: 8, paddingHorizontal: 11, alignItems: "center", borderRadius: 13, borderWidth: 1, borderColor: "#E2E4EC", backgroundColor: "white" }, liveMetricNumber: { color: "#171923", fontSize: 16, fontWeight: "800" }, liveMetricLabel: { color: "#7B808E", fontSize: 9, fontWeight: "600" },
  overviewActions: { flexDirection: "row", alignItems: "center", gap: 8 }, mobileNewTask: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: 13, backgroundColor: "#1B1E2B" }, mobileNewTaskText: { color: "white", fontSize: 21, lineHeight: 23, fontWeight: "600" }, newTaskMobile: { padding: 20, gap: 10 }, newTaskPrompt: { minHeight: 150, textAlignVertical: "top" },
  notificationBadge: { position: "absolute", top: -5, right: -5, minWidth: 17, height: 17, paddingHorizontal: 3, alignItems: "center", justifyContent: "center", borderRadius: 9, backgroundColor: "#E45E50" }, notificationBadgeText: { color: "white", fontSize: 8, fontWeight: "800" }, mobileInbox: { padding: 16 }, mobileInboxItem: { minHeight: 70, marginBottom: 9, padding: 14, flexDirection: "row", alignItems: "center", gap: 11, borderWidth: 1, borderColor: "#E1E3EA", borderRadius: 14, backgroundColor: "white" }, mobileInboxRead: { opacity: .55 }, mobileInboxDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: "#6266EA" }, mobileInboxDotError: { backgroundColor: "#E45E50" }, mobileInboxDotAttention: { backgroundColor: "#E7A33E" },
  resultLink: { marginTop: 5, color: "#6266EA", fontSize: 9, fontWeight: "700" }, notificationResultSummary: { marginTop: 4, color: "#4D5260", fontSize: 11, lineHeight: 16 }, mobileAutomationAlert: { position: "absolute", zIndex: 50, top: 82, left: 14, right: 14, minHeight: 68, padding: 12, flexDirection: "row", alignItems: "center", gap: 11, borderWidth: 1, borderColor: "#C8CAF7", borderRadius: 15, backgroundColor: "white", shadowColor: "#171923", shadowOffset: { width: 0, height: 9 }, shadowOpacity: .16, shadowRadius: 24, elevation: 8 }, mobileAutomationAlertIcon: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: "#EEEFFF" },
  tourMobile: { flex: 1, backgroundColor: "#F5F6FA" }, tourMobileArt: { flex: 1.05, alignItems: "center", justifyContent: "center", gap: 30, backgroundColor: "#1B1E2B" }, tourMiniBoard: { width: "78%", height: 170, padding: 12, flexDirection: "row", gap: 8, borderRadius: 18, backgroundColor: "rgba(255,255,255,.08)" }, tourMiniColumn: { flex: 1, borderRadius: 11, backgroundColor: "rgba(255,255,255,.16)" }, tourMobileCopy: { flex: .95, padding: 28, justifyContent: "center" }, tourMobileTitle: { marginTop: 8, color: "#171923", fontSize: 30, lineHeight: 35, fontWeight: "800", letterSpacing: -1 }, tourMobileText: { marginTop: 12, color: "#747987", fontSize: 14, lineHeight: 22 }, tourMobileDots: { marginTop: 25, marginBottom: 10, flexDirection: "row", gap: 6 }, tourMobileDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#D3D5DE" }, tourMobileDotActive: { width: 24, backgroundColor: "#6266EA" },
  projectFilter: { minHeight: 50, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: "#E0E2E9", borderRadius: 13, backgroundColor: "white" }, projectFilterLabel: { color: "#969AA6", fontSize: 8, fontWeight: "800", letterSpacing: 1 }, projectFilterValue: { marginTop: 3, color: "#292C35", fontSize: 13, fontWeight: "700" }, projectFilterChevron: { color: "#6266EA", fontSize: 19 },
  categoryTabsScroll: { flexGrow: 0, flexShrink: 0, height: 52 }, categoryTabs: { height: 52, paddingHorizontal: 16, paddingBottom: 10, alignItems: "center", gap: 8 }, categoryTab: { height: 38, paddingLeft: 14, paddingRight: 7, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 19, borderWidth: 1, borderColor: "#E0E2E9", backgroundColor: "white" }, categoryTabActive: { borderColor: "#1B1E2B", backgroundColor: "#1B1E2B" }, categoryTabText: { color: "#686D7A", fontSize: 12, fontWeight: "700" }, categoryTabTextActive: { color: "white" }, categoryTabCount: { minWidth: 23, height: 23, paddingHorizontal: 6, textAlign: "center", textAlignVertical: "center", borderRadius: 12, overflow: "hidden", color: "#6F7481", backgroundColor: "#F0F1F5", fontSize: 10, fontWeight: "800" }, categoryTabCountActive: { color: "#1B1E2B", backgroundColor: "white" },
  taskList: { flex: 1 }, taskListContent: { paddingHorizontal: 16, paddingBottom: 28 }, listHeading: { marginTop: 7, marginBottom: 12, paddingHorizontal: 3, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, listTitle: { color: "#242630", fontSize: 14, fontWeight: "800" }, listCount: { color: "#858A96", fontSize: 10, fontWeight: "600" },
  cardTop: { minHeight: 24, marginBottom: 9, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, projectPill: { maxWidth: "68%", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 7, overflow: "hidden", color: "#747987", backgroundColor: "#F1F2F6", fontSize: 9, fontWeight: "700" }, workingPill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: "#EEEFFF" }, workingPillText: { color: "#6266EA", fontSize: 9, fontWeight: "800" }, cardBottom: { marginTop: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, openArrow: { color: "#6266EA", fontSize: 18, fontWeight: "700" }, moveLinkText: { color: "#858A96", fontSize: 10, fontWeight: "700" },
  emptyColumn: { minHeight: 240, marginTop: 5, alignItems: "center", justifyContent: "center", borderWidth: 1, borderStyle: "dashed", borderColor: "#D8DAE3", borderRadius: 18, backgroundColor: "rgba(255,255,255,.45)" }, emptyIcon: { color: "#A1A5B1", fontSize: 31 }, emptyTitle: { marginTop: 9, color: "#333640", fontSize: 15, fontWeight: "700" }, emptyText: { maxWidth: 230, marginTop: 5, textAlign: "center", color: "#858A96", fontSize: 11, lineHeight: 17 },
  chatBackButton: { width: 48, height: 48, flexShrink: 0, alignItems: "center", justifyContent: "center", borderRadius: 14, borderWidth: 1, borderColor: "#E1E3EA", backgroundColor: "#FAFAFC" }, chatTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 }, chatState: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8, backgroundColor: "#F0F1F5" }, chatStateLive: { backgroundColor: "#EEEFFF" }, chatStateText: { color: "#7C818E", fontSize: 8, fontWeight: "800" }, chatStateTextLive: { color: "#6266EA" }, stopButton: { paddingHorizontal: 11, paddingVertical: 8, borderRadius: 10, backgroundColor: "#FFF0ED" },
  choiceDialog: { maxHeight: "78%", padding: 20, paddingTop: 10, borderRadius: 24, backgroundColor: "#F8F8FB" }, choiceList: { marginTop: 16 }, choiceRow: { minHeight: 60, marginBottom: 8, paddingHorizontal: 15, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: "#E1E3EA", borderRadius: 14, backgroundColor: "white" }, choiceRowSelected: { borderColor: "#8D90ED", backgroundColor: "#F1F1FF" }, choiceMain: { flex: 1, minHeight: 58, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, archiveProjectButton: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: 9, backgroundColor: "#FDEDEC" }, archiveIcon: { color: "#B54A3C", fontSize: 18, lineHeight: 20 }, choiceLabel: { color: "#262832", fontSize: 14, fontWeight: "700" }, choiceCheck: { color: "#6266EA", fontSize: 17, fontWeight: "800" },
  forkSourceMobile:{padding:14,borderRadius:13,backgroundColor:"white",borderWidth:1,borderColor:"#E1E3EA"},forkHistoryChoice:{minHeight:58,marginBottom:8,paddingHorizontal:14,flexDirection:"row",alignItems:"center",justifyContent:"space-between",borderWidth:1,borderColor:"#E1E3EA",borderRadius:13,backgroundColor:"white"},forkHistoryChoiceActive:{borderColor:"#8D90ED",backgroundColor:"#F1F1FF"},forkHistoryLabel:{flex:1,paddingRight:10,color:"#3A3D48",fontSize:12,lineHeight:17,fontWeight:"600"},forkNoteMobile:{marginVertical:8,color:"#7C818E",fontSize:11,lineHeight:17},
  automationHeaderNew: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: "#1B1E2B" }, automationHeaderNewIcon: { color: "white", fontSize: 20, lineHeight: 22, fontWeight: "600" }, workflowCreateChoices: { gap: 9, marginBottom: 20 }, workflowCreateCard: { minHeight: 68, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 11, borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 15, backgroundColor: "white" }, automationEmpty: { minHeight: 260, alignItems: "center", justifyContent: "center", borderWidth: 1, borderStyle: "dashed", borderColor: "#D8DAE3", borderRadius: 18, backgroundColor: "rgba(255,255,255,.45)" }, automationComposer: { padding: 14, gap: 10, borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 17, backgroundColor: "white" }, segmented: { padding: 3, flexDirection: "row", borderRadius: 12, backgroundColor: "#EFF0F4" }, segment: { flex: 1, minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: 9 }, segmentActive: { backgroundColor: "#1B1E2B" }, segmentText: { color: "#727784", fontSize: 11, fontWeight: "700" }, segmentTextActive: { color: "white" }, fieldLabel: { marginTop: 5, color: "#8A8F9B", fontSize: 8, fontWeight: "800", letterSpacing: 1 }, miniChoices: { gap: 7 }, miniChoice: { maxWidth: 190, minHeight: 36, paddingHorizontal: 11, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#E0E2E9", borderRadius: 11, backgroundColor: "#F9F9FB" }, miniChoiceActive: { borderColor: "#8588EC", backgroundColor: "#EEEFFF" }, miniChoiceText: { color: "#696E7B", fontSize: 10, fontWeight: "700" }, miniChoiceTextActive: { color: "#5559D8" }, promptInput: { minHeight: 76, textAlignVertical: "top" }, automationSectionTitle: { marginTop: 24, marginBottom: 10, marginLeft: 3, color: "#858A96", fontSize: 9, fontWeight: "800", letterSpacing: 1 }, automationCard: { marginBottom: 10, padding: 14, borderWidth: 1, borderColor: "#E1E3EA", borderRadius: 15, backgroundColor: "white" }, automationCardTop: { flexDirection: "row", alignItems: "center", gap: 11 }, automationIcon: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 11, backgroundColor: "#EEEFFF" }, automationName: { color: "#252832", fontSize: 13, fontWeight: "800" }, automationDescription: { marginTop: 3, color: "#7F8491", fontSize: 10, lineHeight: 15 }, automationError: { marginTop: 4, color: "#B54A3C", fontSize: 9 }, toggle: { width: 42, height: 24, padding: 3, justifyContent: "center", borderRadius: 12, backgroundColor: "#D8DAE1" }, toggleOn: { backgroundColor: "#6266EA" }, toggleKnob: { width: 18, height: 18, borderRadius: 9, backgroundColor: "white" }, toggleKnobOn: { alignSelf: "flex-end" }, deleteAutomation: { marginTop: 10, alignSelf: "flex-end", color: "#B54A3C", fontSize: 10, fontWeight: "700" },
  mobileChatToolbar: { flexDirection: "row", gap: 9, paddingHorizontal: 11, paddingTop: 9, backgroundColor: "white" }, mobileToolButton: { flex: 1, minWidth: 0, minHeight: 42, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 7, borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 11, backgroundColor: "#FAFAFC" }, mobileToolLabel: { color: "#858A96", fontSize: 9, fontWeight: "800" }, mobileToolValue: { flex: 1, minWidth: 0, color: "#5559D8", fontSize: 12, fontWeight: "800" }, mobileToolChevron: { color: "#858A96", fontSize: 16 }, mobileAttachmentButton: { width: 94, minHeight: 42, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 11, backgroundColor: "#FAFAFC" }, mobileAttachmentIcon: { color: "#5559D8", fontSize: 18, lineHeight: 20 }, mobileAttachmentLabel: { color: "#5559D8", fontSize: 10, fontWeight: "800" }, modelRequiredHint: { marginHorizontal: 13, marginTop: 5, color: "#A4493D", fontSize: 9, fontWeight: "700" }, toolModalBackdrop: { flex: 1, justifyContent: "flex-end", padding: 10, backgroundColor: "rgba(18,20,28,.42)" }, toolModal: { maxHeight: "88%", padding: 16, borderRadius: 20, backgroundColor: "#F8F8FA" }, attachModal: { padding: 16, borderRadius: 20, backgroundColor: "#F8F8FA" }, toolModalHeader: { marginBottom: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }, toolModalTitle: { color: "#1B1E2B", fontSize: 16, fontWeight: "800" }, toolModalSubtitle: { marginTop: 4, color: "#858A96", fontSize: 12 }, modalCloseButton: { width: 48, height: 48, flexShrink: 0, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: "#ECEEF3" }, modelOptionList: { marginBottom: 7, padding: 3, borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 12, backgroundColor: "white" }, modelOption: { minHeight: 50, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 9 }, modelOptionSelected: { backgroundColor: "#EEEFFF" }, modelOptionCopy: { flex: 1, minWidth: 0 }, modelOptionName: { color: "#252832", fontSize: 14, fontWeight: "800" }, modelOptionId: { marginTop: 3, color: "#858A96", fontSize: 11 }, modelOptionCheck: { color: "#5559D8", fontSize: 16, fontWeight: "800" }, toolSectionLabel: { marginTop: 16, marginBottom: 8, color: "#858A96", fontSize: 10, fontWeight: "900", letterSpacing: 1 }, toolChoiceRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 }, toolChoice: { minHeight: 44, paddingHorizontal: 10, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 9, backgroundColor: "white" }, toolChoiceSelected: { borderColor: "#777BE9", backgroundColor: "#EEEFFF" }, toolChoiceText: { color: "#717684", fontSize: 12, fontWeight: "700" }, toolChoiceTextSelected: { color: "#5559D8" }, toolModalFooter: { marginTop: 16, flexDirection: "row", justifyContent: "space-between", gap: 8 }, compactMobileButton: { minHeight: 40, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 10, backgroundColor: "white" }, compactMobileText: { color: "#5559D8", fontSize: 10, fontWeight: "800" }, toolDoneButton: { minHeight: 40, minWidth: 76, paddingHorizontal: 14, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: "#1B1E2B" }, toolDoneText: { color: "white", fontSize: 10, fontWeight: "800" }, attachChoice: { minHeight: 64, marginBottom: 4, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 11, borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 13, backgroundColor: "white" }, attachChoiceIcon: { width: 36, height: 36, alignItems: "center", justifyContent: "center", textAlign: "center", textAlignVertical: "center", borderRadius: 11, overflow: "hidden", color: "#5559D8", backgroundColor: "#EEEFFF", fontSize: 21 }, attachChoiceTitle: { color: "#252832", fontSize: 11, fontWeight: "800" }, attachChoiceSubtitle: { marginTop: 4, color: "#858A96", fontSize: 9 }, settingsRow: { minHeight: 64, marginBottom: 8, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: "#E2E4EC", borderRadius: 13, backgroundColor: "white" },
  automationOutcome: { marginTop: 8, fontSize: 11, fontWeight: "800" }, outcomeSuccess: { color: "#177C50" }, outcomeFailed: { color: "#B34337" }, outcomeUnknown: { color: "#796026" },
  automationEditActions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8 },
  automationModes: { gap: 6, padding: 3, borderRadius: 12, backgroundColor: "#EFF0F4" }, automationMode: { minWidth: 76, minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: 9 }, automationModeActive: { backgroundColor: "#1B1E2B" },
  mobileWeekdays: { flexDirection: "row", justifyContent: "space-between", gap: 5 }, mobileWeekday: { flex: 1, height: 36, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#E0E2E9", borderRadius: 10, backgroundColor: "#F9F9FB" },
  newTaskAttach: { minHeight: 38, alignSelf: "flex-start", paddingHorizontal: 12, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 10, backgroundColor: "white" }, newTaskAttachText: { color: "#5559D8", fontSize: 10, fontWeight: "800" },
  composerShell: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 9, borderTopWidth: StyleSheet.hairlineWidth, borderColor: "#DFE1E8", backgroundColor: "white" }, composerCard: { padding: 8, borderWidth: 1, borderColor: "#D9DCE5", borderRadius: 16, backgroundColor: "white" }, composerBottomRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingTop: 4 }, composerToolRow: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 }, composerAttachButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 11, backgroundColor: "#FAFAFC" }, composerAttachmentStrip: { paddingVertical: 4, gap: 6 }, composerAttachmentChip: { width: 154, minHeight: 40, paddingHorizontal: 5, flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 10, backgroundColor: "#FAFAFC" }, composerAttachmentThumb: { width: 30, height: 30, borderRadius: 7 }, composerAttachmentName: { flex: 1, color: "#555966", fontSize: 9 }, composerAttachmentRemove: { width: 22, height: 28, alignItems: "center", justifyContent: "center" },
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
