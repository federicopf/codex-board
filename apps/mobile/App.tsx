import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform,
  Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import Markdown from "react-native-markdown-display";
import {
  categoryFromTitle, displayTitle, formatCodexDirectives, parsePairingPayload, threadNameWithTitle,
  type Automation, type BoardConfig, type BoardNotification, type CreateAutomationInput, type JsonValue, type PairingCredential,
  type PendingRemoteRequest, type QueuedMessage, type ThreadDto,
} from "@codex-board/protocol";
import { BoardApi } from "./src/api";
import { clearCredential, hasSeenTour, loadCredential, loadSelectedBoard, markTourSeen, saveCredential, saveSelectedBoard } from "./src/connection";
import { MobileBoardHome } from "./src/MobileBoardHome";
import { AutomationResultModal } from "./src/AutomationResultModal";

type JsonObject = Record<string, JsonValue>;
const object = (value: JsonValue | undefined): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const string = (value: JsonValue | undefined): string => typeof value === "string" ? value : "";
const requestThreadId = (request: PendingRemoteRequest) => string(object(request.params).threadId);
const visibleUserMessage = (value: string) => value.replace(/\n*<!-- codex-board-automation:[\s\S]*?-->/g, "").trimEnd();

interface ChatLine { id: string; role: "user" | "assistant" | "activity"; text: string; title?: string; status?: string; }

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
        lines.push({ id, role: "user", text: visibleUserMessage(content) });
      } else if (type === "agentMessage") {
        lines.push({ id, role: "assistant", text: string(item.text) });
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

function projectBoards(threads: ThreadDto[]): { key: string; label: string; cwd: string; count: number }[] {
  const values = [...new Map(threads.map((thread) => {
    const cwd = thread.cwd || "Local project";
    return [projectKey(thread.cwd), { key: projectKey(thread.cwd), cwd, base: projectLabel(thread.cwd) }];
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
    return `Every ${action.everyMinutes} min · ${displayTitle(thread?.name || null, thread?.preview || null)}`;
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

function MobileChatComposer({ threadId, api, working, onChanged }: { threadId: string; api: BoardApi; working: boolean; onChanged: () => void }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [summary, setSummary] = useState("auto");
  const [tier, setTier] = useState("");
  const [models, setModels] = useState<Array<{ id: string; name: string; efforts: string[]; tiers: Array<{ id: string; name: string }> }>>([]);
  const [attachments, setAttachments] = useState<Array<{ id: string; name: string; uri: string; dataUrl: string }>>([]);
  const [activeTool, setActiveTool] = useState<"model" | "attachments" | null>(null);
  const [uploading, setUploading] = useState(false);
  useEffect(() => { let alive = true; void api.models().then((value) => { const data = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).data : null; if (!alive || !Array.isArray(data)) return; const next = data.map((item) => { const row = item as Record<string, unknown>; const effortItems = Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts.map((entry) => (entry as Record<string, unknown>)?.reasoningEffort).filter((entry): entry is string => typeof entry === "string") : []; const tierItems = Array.isArray(row.serviceTiers) ? row.serviceTiers.map((entry) => { const value = entry as Record<string, unknown>; return { id: String(value?.id || ""), name: String(value?.name || value?.id || "") }; }).filter((entry) => entry.id) : []; return { id: typeof row.model === "string" ? row.model : String(row.id || ""), name: typeof row.displayName === "string" ? row.displayName : String(row.model || row.id || ""), efforts: effortItems, tiers: tierItems }; }).filter((item) => item.id); setModels(next); if (model && !next.some((item) => item.id === model)) setModel(""); }).catch(() => { /* catalog error is shown by the selector state */ }); return () => { alive = false; }; }, [api]);
  const selectedModel = models.find((item) => item.id === model);
  const availableEfforts = selectedModel?.efforts.length ? selectedModel.efforts : ["low", "medium", "high", "xhigh"];

  async function send() {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || busy) return;
    if (!model) { Alert.alert("Choose a model", "Select a Codex model before sending a message."); return; }
    setBusy(true);
    try { await api.send(threadId, text, attachments.map((attachment) => attachment.dataUrl), { model, effort: effort || undefined, summary, serviceTier: tier || undefined }); setDraft(""); setAttachments([]); onChanged(); }
    catch (error) { Alert.alert("Could not send", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function pickImage() {
    if (!model) { setActiveTool("model"); Alert.alert("Choose a model", "Select a Codex model before attaching an image."); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: 10, base64: true, quality: 0.85 });
    if (result.canceled || result.assets.length === 0) return;
    setUploading(true);
    try {
      const selected = result.assets.filter((asset) => Boolean(asset.base64)).map((asset, index) => ({ id: `${Date.now()}-${index}-${Math.random()}`, name: asset.fileName || `Image ${index + 1}`, uri: asset.uri, dataUrl: `data:${asset.mimeType || "image/jpeg"};base64,${asset.base64}` }));
      if (selected.length !== result.assets.length) Alert.alert("Some images skipped", "Codex Board could not read one or more selected images.");
      setAttachments((current) => [...current, ...selected]);
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

  return <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <View style={styles.composerShell}><View style={styles.composerCard}>
      <TextInput value={draft} onChangeText={setDraft} style={styles.composerInput} placeholder={working ? "Add to queue…" : "Message Codex…"} multiline />
      {!model && <Text style={styles.modelRequiredHint}>Choose a model before sending.</Text>}
      {attachments.length > 0 && <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.composerAttachmentStrip}>{attachments.map((attachment) => <View key={attachment.id} style={styles.composerAttachmentChip}><Image source={{ uri: attachment.uri }} style={styles.composerAttachmentThumb} /><Text numberOfLines={1} style={styles.composerAttachmentName}>{attachment.name}</Text><Pressable accessibilityRole="button" accessibilityLabel={`Remove ${attachment.name}`} style={styles.composerAttachmentRemove} onPress={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}><Text style={styles.remove}>×</Text></Pressable></View>)}</ScrollView>}
      <View style={styles.composerBottomRow}><View style={styles.composerToolRow}>
        <Pressable accessibilityRole="button" accessibilityLabel="Model and turn settings" style={styles.mobileToolButton} onPress={() => setActiveTool((current) => current === "model" ? null : "model")}><Text style={styles.mobileToolLabel}>Model</Text><Text style={styles.mobileToolValue} numberOfLines={1}>{selectedModel?.name || "Select model"}</Text><Text style={styles.mobileToolChevron}>⌄</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Attachments" style={styles.composerAttachButton} disabled={uploading} onPress={() => setActiveTool((current) => current === "attachments" ? null : "attachments")}><Text style={styles.mobileAttachmentIcon}>＋</Text></Pressable>
      </View><Pressable disabled={(!draft.trim() && attachments.length === 0) || busy} style={[styles.send, ((!draft.trim() && attachments.length === 0) || busy) && styles.disabled]} onPress={() => void send()}><Text style={styles.primaryButtonText}>{working ? "Queue" : "Send"}</Text></Pressable></View>
    </View></View>
    <Modal visible={activeTool !== null} transparent animationType="fade" onRequestClose={() => setActiveTool(null)}><View style={styles.toolModalBackdrop}><Pressable style={StyleSheet.absoluteFill} onPress={() => setActiveTool(null)} accessibilityRole="button" accessibilityLabel="Close chat tools"/><View style={activeTool === "model" ? styles.toolModal : styles.attachModal}>
      <View style={styles.toolModalHeader}><View><Text style={styles.toolModalTitle}>{activeTool === "model" ? "Model & turn settings" : "Attachments"}</Text><Text style={styles.toolModalSubtitle}>{activeTool === "model" ? (models.length ? `${models.length} models available in Codex` : "Loading model catalog…") : "Select one or more images to send with your message"}</Text></View><Pressable style={styles.modalCloseButton} onPress={() => setActiveTool(null)}><Text style={styles.closeIcon}>×</Text></Pressable></View>
      {activeTool === "model" ? <>
        <ScrollView style={styles.modelOptionList}>{models.map((item) => <Pressable key={item.id} style={[styles.modelOption, model === item.id && styles.modelOptionSelected]} onPress={() => { setModel(item.id); setEffort(""); setTier(""); }}><View style={styles.modelOptionCopy}><Text style={styles.modelOptionName}>{item.name}</Text><Text numberOfLines={1} style={styles.modelOptionId}>{item.id}</Text></View>{model === item.id && <Text style={styles.modelOptionCheck}>✓</Text>}</Pressable>)}</ScrollView>
        <Text style={styles.toolSectionLabel}>REASONING EFFORT</Text><View style={styles.toolChoiceRow}>{availableEfforts.map((item) => <Pressable key={item} style={[styles.toolChoice, effort === item && styles.toolChoiceSelected]} onPress={() => setEffort(effort === item ? "" : item)}><Text style={[styles.toolChoiceText, effort === item && styles.toolChoiceTextSelected]}>{item}</Text></Pressable>)}</View>
        <Text style={styles.toolSectionLabel}>SUMMARY</Text><View style={styles.toolChoiceRow}>{["auto", "concise", "detailed", "none"].map((item) => <Pressable key={item} style={[styles.toolChoice, summary === item && styles.toolChoiceSelected]} onPress={() => setSummary(item)}><Text style={[styles.toolChoiceText, summary === item && styles.toolChoiceTextSelected]}>{item}</Text></Pressable>)}</View>
        {Boolean(selectedModel?.tiers.length) && <><Text style={styles.toolSectionLabel}>SERVICE TIER</Text><View style={styles.toolChoiceRow}>{selectedModel?.tiers.map((item) => <Pressable key={item.id} style={[styles.toolChoice, tier === item.id && styles.toolChoiceSelected]} onPress={() => setTier(tier === item.id ? "" : item.id)}><Text style={[styles.toolChoiceText, tier === item.id && styles.toolChoiceTextSelected]}>{item.name}</Text></Pressable>)}</View></>}
        <View style={styles.toolModalFooter}><Pressable disabled={!model || working || busy} style={[styles.compactMobileButton, (!model || working || busy) && styles.disabled]} onPress={() => void compact()}><Text style={styles.compactMobileText}>{busy ? "Compacting…" : "Compact conversation"}</Text></Pressable><Pressable style={styles.toolDoneButton} onPress={() => setActiveTool(null)}><Text style={styles.toolDoneText}>Done</Text></Pressable></View>
      </> : <Pressable disabled={!model || uploading} style={[styles.attachChoice, (!model || uploading) && styles.disabled]} onPress={() => void pickImage()}><Text style={styles.attachChoiceIcon}>＋</Text><View><Text style={styles.attachChoiceTitle}>Choose images</Text><Text style={styles.attachChoiceSubtitle}>{model ? "Select multiple from your photo library" : "Choose a model first"}</Text></View></Pressable>}
    </View></View></Modal>
  </KeyboardAvoidingView>;
}

function Chat({ thread, api, queue, requests, eventRevision, onClose, onChanged, onFork, onRename }: { thread: ThreadDto; api: BoardApi; queue: QueuedMessage[]; requests: PendingRemoteRequest[]; eventRevision: number; onClose: () => void; onChanged: () => void; onFork: () => void; onRename: () => void }) {
  const [loaded, setLoaded] = useState<JsonObject | null>(() => threadCache.get(thread.id) || null);
  const lines = useMemo(() => conversation(loaded), [loaded]);
  const timeline = useMemo(() => [...lines].reverse(), [lines]);
  const refresh = useCallback(() => void api.thread(thread.id).then((next) => { threadCache.set(thread.id, next); setLoaded(next); }).catch((error) => Alert.alert("Chat unavailable", error.message)), [api, thread.id]);
  useEffect(refresh, [refresh]);
  useEffect(() => { if (eventRevision > 0) refresh(); }, [eventRevision, refresh]);

  const turnId = activeTurnId(loaded);
  return <Modal animationType="slide" onRequestClose={onClose}><SafeAreaView style={styles.page}>
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to board" style={styles.chatBackButton} onPress={onClose}><Text style={styles.back}>←</Text></Pressable>
      <View style={styles.headerCopy}><View style={styles.chatTitleRow}><Text style={styles.headerTitle} numberOfLines={1}>{displayTitle(thread.name, thread.preview)}</Text><View style={[styles.chatState, turnId && styles.chatStateLive]}><Text style={[styles.chatStateText, turnId && styles.chatStateTextLive]}>{turnId ? "Working" : "Ready"}</Text></View></View><Text style={styles.headerMeta} numberOfLines={1}>{projectLabel(thread.cwd)}{thread.forkedFromId?" · Forked conversation":""}</Text></View>
      <View style={styles.topbarActions}>
        <Pressable accessibilityRole="button" accessibilityLabel="Rename conversation" style={styles.topbarIconButton} onPress={onRename}><Text style={styles.topbarForkIcon}>✎</Text></Pressable>
        {turnId?<Pressable accessibilityRole="button" accessibilityLabel="Stop Codex" style={[styles.topbarIconButton, styles.topbarIconDanger]} onPress={() => void api.interrupt(thread.id, turnId)}><Text style={styles.stopIcon}>■</Text></Pressable>:<Pressable accessibilityRole="button" accessibilityLabel="Fork conversation" style={styles.topbarIconButton} onPress={onFork}><Text style={styles.topbarForkIcon}>⑂</Text></Pressable>}
      </View>
    </View>
    <FlatList inverted style={styles.chat} contentContainerStyle={styles.chatContent} data={timeline} keyExtractor={(item) => item.id} maintainVisibleContentPosition={{ minIndexForVisible: 0 }} ListEmptyComponent={<Text style={styles.empty}>No messages yet.</Text>} renderItem={({ item }) => <View style={[styles.bubble, styles[`bubble_${item.role}`]]}>{item.role !== "user" && <View style={styles.activityHeading}><Text style={styles.bubbleLabel}>{item.role === "assistant" ? "CODEX" : item.title || "ACTIVITY"}</Text>{item.status&&<Text style={styles.activityStatus}>{item.status}</Text>}</View>}{item.role === "assistant" ? <Markdown style={markdownStyles}>{formatCodexDirectives(item.text || "…")}</Markdown> : item.role === "activity" ? <Markdown style={markdownStyles}>{formatCodexDirectives(item.text || "…")}</Markdown> : <Text style={[styles.bubbleText, styles.userText]}>{item.text || "…"}</Text>}</View>} ListHeaderComponent={<>
      {queue.length > 0 && <View style={styles.queueBox}><Text style={styles.requestTitle}>{queue.length} queued</Text>{queue.map((message, index) => { const count = message.imageUrls?.length || Number(Boolean(message.imageUrl)); return <View key={message.id} style={styles.queueRow}><Text style={styles.queueIndex}>{index + 1}</Text><Text style={styles.queueText}>{message.text || `${count} image${count === 1 ? "" : "s"} attached`}</Text><Pressable onPress={() => void api.removeQueued(thread.id, message.id).then(onChanged)}><Text style={styles.remove}>×</Text></Pressable></View>; })}</View>}
      {requests.map((request) => <RequestCard key={JSON.stringify(request.requestId)} request={request} api={api} onDone={onChanged} />)}
    </>} />
    <View style={{ backgroundColor: "white" }}><MobileChatComposer key={thread.id} threadId={thread.id} api={api} working={Boolean(turnId)} onChanged={onChanged} /></View>
  </SafeAreaView></Modal>;
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

  return <Modal animationType="slide"><SafeAreaView style={styles.page}><View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel="Close category manager" style={styles.chatBackButton} onPress={onClose}><Text style={styles.closeIcon}>×</Text></Pressable><View style={styles.headerCopy}><Text style={styles.headerTitle}>Manage categories</Text><Text style={styles.headerMeta}>Synced with desktop in real time</Text></View></View><ScrollView contentContainerStyle={styles.manager}>
    <View style={styles.managerIntro}><Text style={styles.overviewEyebrow}>BOARD STRUCTURE</Text><Text style={styles.managerTitle}>Make the board yours</Text><Text style={styles.managerSubtitle}>Create, rename and reorder columns. Categories are driven by your prefixes.</Text></View>
    <View style={styles.modeRow}><View style={styles.categoryCopy}><Text style={styles.cardTitle}>Approvals</Text><Text style={styles.headerMeta}>{config.approvalMode === "auto" ? "Commands and changes are approved automatically" : "Ask on desktop or mobile"}</Text></View><Pressable style={styles.denyButton} onPress={() => void api.updateBoard({ ...config, approvalMode: config.approvalMode === "auto" ? "ask" : "auto" }).then(onSaved)}><Text>{config.approvalMode === "auto" ? "Use Ask" : "Use Auto"}</Text></Pressable></View>
    <View style={styles.addRow}><TextInput style={[styles.smallInput, { flex: 1 }]} value={draft} onChangeText={setDraft} placeholder="Category name" /><Pressable disabled={busy} style={styles.allowButton} onPress={() => void add()}><Text style={styles.primaryButtonText}>Add</Text></Pressable></View>
    {categories.map((category, index) => { const count = threads.filter((thread) => categoryFromTitle(thread.name) === category).length; return <View key={category} style={styles.categoryRow}><View style={styles.categoryCopy}><Text style={styles.cardTitle}>{category}</Text><Text style={styles.headerMeta}>{count} tasks</Text></View><Pressable disabled={index === 0 || busy} onPress={() => { const next = [...categories]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; setCategories(next); void save(next); }}><Text style={styles.orderButton}>↑</Text></Pressable><Pressable disabled={index === categories.length - 1 || busy} onPress={() => { const next = [...categories]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; setCategories(next); void save(next); }}><Text style={styles.orderButton}>↓</Text></Pressable><Pressable disabled={busy} onPress={() => rename(category)}><Text style={styles.editButton}>Edit</Text></Pressable>{editing === category && <Pressable onPress={() => void applyRename(category)}><Text style={styles.editButton}>Rename</Text></Pressable>}{count === 0 && <Pressable disabled={busy} onPress={() => { const next = categories.filter((item) => item !== category); setCategories(next); void save(next); }}><Text style={styles.deleteButton}>Delete</Text></Pressable>}</View>; })}
    <Text style={styles.automationSectionTitle}>HELP & CONNECTION</Text>
    <Pressable style={styles.settingsRow} onPress={() => { onClose(); onOpenTour(); }}><View><Text style={styles.cardTitle}>Product tour</Text><Text style={styles.headerMeta}>Reopen the illustrated guide</Text></View><Text style={styles.moveChevron}>›</Text></Pressable>
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
  return <Modal transparent animationType="fade" onRequestClose={() => { if (!busy) onClose(); }}><View style={styles.modalBackdrop}><Pressable disabled={busy} style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close move task dialog"/><View style={styles.moveDialog}><View style={styles.sheetHandle} /><Text style={styles.moveEyebrow}>MOVE TASK</Text><Text style={styles.moveTitle} numberOfLines={2}>{displayTitle(thread.name, thread.preview)}</Text><Text style={styles.moveSubtitle}>Choose the next board stage.</Text><ScrollView style={styles.moveOptions}>{categories.map((category) => { const selected = category === current; return <Pressable key={category} disabled={busy || selected} style={[styles.moveOption, selected && styles.moveOptionSelected]} onPress={() => void move(category)}><View style={[styles.categoryDot, selected && styles.categoryDotSelected]} /><Text style={[styles.moveOptionText, selected && styles.moveOptionTextSelected]}>{category}</Text>{selected ? <Text style={styles.currentLabel}>CURRENT</Text> : <Text style={styles.moveChevron}>›</Text>}</Pressable>; })}</ScrollView><Pressable style={styles.moveCancel} onPress={onClose}><Text style={styles.moveCancelText}>Cancel</Text></Pressable></View></View></Modal>;
}

function ChoiceModal({ title, subtitle, options, selected, onSelect, onClose, onArchiveProject }: { title: string; subtitle?: string; options: { key: string; label: string; meta?: string }[]; selected: string; onSelect: (key: string) => void; onClose: () => void; onArchiveProject?: (option: { key: string; label: string }) => void }) {
  return <Modal transparent animationType="fade" onRequestClose={onClose}><View style={styles.modalBackdrop}><Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel={`Close ${title.toLowerCase()} dialog`}/><View style={styles.choiceDialog}><View style={styles.sheetHandle} /><Text style={styles.moveTitle}>{title}</Text>{subtitle&&<Text style={styles.moveSubtitle}>{subtitle}</Text>}<ScrollView style={styles.choiceList}>{options.map((option) => <View key={option.key} style={[styles.choiceRow, option.key === selected && styles.choiceRowSelected]}><Pressable style={styles.choiceMain} onPress={() => { onSelect(option.key); onClose(); }}><View style={styles.categoryCopy}><Text style={styles.choiceLabel}>{option.label}</Text>{option.meta && <Text style={styles.headerMeta}>{option.meta}</Text>}</View>{option.key === selected && <Text style={styles.choiceCheck}>✓</Text>}</Pressable>{onArchiveProject && option.key !== ALL_PROJECTS && <Pressable style={styles.archiveProjectButton} onPress={() => onArchiveProject(option)} accessibilityRole="button" accessibilityLabel={`Archive ${option.label}`}><Text style={styles.archiveIcon}>□</Text></Pressable>}</View>)}</ScrollView><Pressable style={styles.moveCancel} onPress={onClose}><Text style={styles.moveCancelText}>Cancel</Text></Pressable></View></View></Modal>;
}

function NewTaskModal({ api, threads, categories, defaultProjectKey, onClose, onCreated }: { api: BoardApi; threads: ThreadDto[]; categories: string[]; defaultProjectKey?: string; onClose: () => void; onCreated: (thread: ThreadDto) => void }) {
  const projects = projectBoards(threads).filter((project) => project.key !== "__local__");
  const [cwd, setCwd] = useState(projects.find((project) => project.key === defaultProjectKey)?.cwd || projects[0]?.cwd || ""); const [category, setCategory] = useState(categories[0] || "Uncategorized"); const [title, setTitle] = useState(""); const [prompt, setPrompt] = useState(""); const [busy, setBusy] = useState(false);
  async function create() { setBusy(true); try { const created = await api.createThread({ cwd, category, title: title.trim(), prompt: prompt.trim() }); onCreated(created); } catch (error) { Alert.alert("Could not create task", error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }
  return <Modal animationType="slide"><SafeAreaView style={styles.page}><View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel="Cancel new task" style={styles.chatBackButton} onPress={onClose}><Text style={styles.closeIcon}>×</Text></Pressable><View style={styles.headerCopy}><Text style={styles.headerTitle}>New Codex task</Text><Text style={styles.headerMeta}>Create and start directly from mobile</Text></View></View><ScrollView contentContainerStyle={styles.newTaskMobile}><Text style={styles.fieldLabel}>PROJECT</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.miniChoices}>{projects.map((project) => <Pressable key={project.cwd} style={[styles.miniChoice, project.cwd === cwd && styles.miniChoiceActive]} onPress={() => setCwd(project.cwd)}><Text style={[styles.miniChoiceText, project.cwd === cwd && styles.miniChoiceTextActive]}>{project.label}</Text></Pressable>)}</ScrollView><Text style={styles.fieldLabel}>CATEGORY</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.miniChoices}>{categories.map((item) => <Pressable key={item} style={[styles.miniChoice, item === category && styles.miniChoiceActive]} onPress={() => setCategory(item)}><Text style={[styles.miniChoiceText, item === category && styles.miniChoiceTextActive]}>{item}</Text></Pressable>)}</ScrollView><Text style={styles.fieldLabel}>TITLE</Text><TextInput style={styles.smallInput} value={title} onChangeText={setTitle} placeholder="What are we building?" returnKeyType="next" /><Text style={styles.fieldLabel}>FIRST MESSAGE</Text><TextInput style={[styles.smallInput, styles.newTaskPrompt]} value={prompt} onChangeText={setPrompt} multiline blurOnSubmit returnKeyType="send" onSubmitEditing={() => { if (!busy && cwd && title.trim() && prompt.trim()) void create(); }} placeholder="Describe what Codex should do…" /><Pressable disabled={busy || !cwd || !title.trim() || !prompt.trim()} style={[styles.primaryButton, (busy || !cwd || !title.trim() || !prompt.trim()) && styles.disabled]} onPress={() => void create()}>{busy ? <ActivityIndicator color="white" /> : <Text style={styles.primaryButtonText}>Create and start</Text>}</Pressable></ScrollView></SafeAreaView></Modal>;
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
  return <Modal animationType="slide"><SafeAreaView style={styles.page}>
    <View style={styles.header}><Pressable disabled={busy} accessibilityRole="button" accessibilityLabel="Cancel fork" style={styles.chatBackButton} onPress={onClose}><Text style={styles.closeIcon}>×</Text></Pressable><View style={styles.headerCopy}><Text style={styles.headerTitle}>Fork conversation</Text><Text style={styles.headerMeta}>Create an independent task in the same project</Text></View></View>
    <ScrollView contentContainerStyle={styles.newTaskMobile}>
      <View style={styles.forkSourceMobile}><Text style={styles.automationName}>{displayTitle(thread.name, thread.preview)}</Text><Text style={styles.automationDescription} numberOfLines={1}>{thread.cwd || "Local Codex project"}</Text></View>
      <Text style={styles.fieldLabel}>CATEGORY</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.miniChoices}>{categories.map((item) => <Pressable key={item} style={[styles.miniChoice,item===category&&styles.miniChoiceActive]} onPress={()=>setCategory(item)}><Text style={[styles.miniChoiceText,item===category&&styles.miniChoiceTextActive]}>{item}</Text></Pressable>)}</ScrollView>
      <Text style={styles.fieldLabel}>NEW TASK TITLE</Text><TextInput style={styles.smallInput} value={title} onChangeText={setTitle} />
      <Text style={styles.fieldLabel}>HISTORY TO COPY</Text>
      {loading?<ActivityIndicator color="#6266EA"/>:<View><Pressable style={[styles.forkHistoryChoice,!lastTurnId&&styles.forkHistoryChoiceActive]} onPress={()=>setLastTurnId("")}><View style={styles.categoryCopy}><Text style={styles.choiceLabel}>Entire conversation</Text><Text style={styles.headerMeta}>Copy all completed turns</Text></View>{!lastTurnId&&<Text style={styles.choiceCheck}>✓</Text>}</Pressable>{turns.map((turn)=><Pressable key={turn.id} style={[styles.forkHistoryChoice,lastTurnId===turn.id&&styles.forkHistoryChoiceActive]} onPress={()=>setLastTurnId(turn.id)}><Text style={styles.forkHistoryLabel} numberOfLines={2}>{turn.label}</Text>{lastTurnId===turn.id&&<Text style={styles.choiceCheck}>✓</Text>}</Pressable>)}</View>}
      <Text style={styles.forkNoteMobile}>Future messages in the fork and original conversation remain completely independent.</Text>
      <Pressable disabled={busy||loading||!title.trim()} style={[styles.primaryButton,(busy||loading||!title.trim())&&styles.disabled]} onPress={()=>void create()}>{busy?<ActivityIndicator color="white"/>:<Text style={styles.primaryButtonText}>Fork and open</Text>}</Pressable>
    </ScrollView>
  </SafeAreaView></Modal>;
}

function InboxModal({ api, items, onClose, onOpen, onOpenResult, onChanged }: { api: BoardApi; items: BoardNotification[]; onClose: () => void; onOpen: (id: string) => void; onOpenResult: (item: BoardNotification) => void; onChanged: () => void }) { return <Modal animationType="slide"><SafeAreaView style={styles.page}><View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel="Close inbox" style={styles.chatBackButton} onPress={onClose}><Text style={styles.closeIcon}>×</Text></Pressable><View style={styles.headerCopy}><Text style={styles.headerTitle}>Inbox</Text><Text style={styles.headerMeta}>Everything that needs your attention</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Mark all notifications as read" style={styles.topbarIconButton} onPress={()=>void api.markNotificationsRead().then(onChanged)}><Text style={styles.readAllIcon}>✓✓</Text></Pressable></View><FlatList contentContainerStyle={styles.mobileInbox} data={items} keyExtractor={item=>item.id} ListEmptyComponent={<View style={styles.emptyColumn}><Text style={styles.emptyTitle}>You're all caught up</Text></View>} renderItem={({item})=><Pressable style={[styles.mobileInboxItem,item.read&&styles.mobileInboxRead]} onPress={()=>{void api.markNotificationsRead(item.id);if(item.automation)onOpenResult(item);else if(item.threadId)onOpen(item.threadId)}}><View style={[styles.mobileInboxDot,item.kind==="error"&&styles.mobileInboxDotError,item.kind==="attention"&&styles.mobileInboxDotAttention]}/><View style={styles.categoryCopy}><Text style={styles.automationName}>{item.title}</Text><Text style={styles.automationDescription}>{item.automation?.name||item.message}</Text>{item.automation&&<Text style={styles.resultLink}>View quick result</Text>}</View><Text style={styles.openArrow}>→</Text></Pressable>} ListFooterComponent={items.length?<Pressable style={styles.moveCancel} onPress={()=>void api.clearNotifications().then(onChanged)}><Text style={styles.deleteAutomation}>Clear notifications</Text></Pressable>:null}/></SafeAreaView></Modal> }

const mobileTourSteps = [["YOUR BOARDS","Projects, separated","Open every project as its own board. Categories still follow your prefixes, while All projects gives you a complete overview."],["REAL CHAT","Continue anywhere","Read history, send instructions, approve commands and answer Codex directly from mobile."],["AUTOMATIONS","Build your routine","Schedule recurring prompts and timed moves that run persistently on your PC."]];
function MobileTour({onDone}:{onDone:()=>void}){const[index,setIndex]=useState(0);const step=mobileTourSteps[index];return <Modal animationType="fade"><SafeAreaView style={styles.tourMobile}><View style={styles.tourMobileArt}><View style={styles.mobileLogo}><View style={[styles.logoBar,{height:9}]}/><View style={[styles.logoBar,{height:18}]}/><View style={[styles.logoBar,{height:13}]}/></View><View style={styles.tourMiniBoard}><View style={styles.tourMiniColumn}/><View style={styles.tourMiniColumn}/><View style={styles.tourMiniColumn}/></View></View><View style={styles.tourMobileCopy}><Text style={styles.overviewEyebrow}>{step[0]}</Text><Text style={styles.tourMobileTitle}>{step[1]}</Text><Text style={styles.tourMobileText}>{step[2]}</Text><View style={styles.tourMobileDots}>{mobileTourSteps.map((_,dot)=><View key={dot} style={[styles.tourMobileDot,dot===index&&styles.tourMobileDotActive]}/>)}</View><Pressable style={styles.primaryButton} onPress={()=>index===mobileTourSteps.length-1?onDone():setIndex(index+1)}><Text style={styles.primaryButtonText}>{index===mobileTourSteps.length-1?"Start using Board":"Next"}</Text></Pressable><Pressable style={styles.moveCancel} onPress={onDone}><Text style={styles.moveCancelText}>Skip guide</Text></Pressable></View></SafeAreaView></Modal>}

function AutomationManager({ api, automations, threads, categories, onClose, onChanged }: { api: BoardApi; automations: Automation[]; threads: ThreadDto[]; categories: string[]; onClose: () => void; onChanged: () => void }) {
  const [view, setView] = useState<"overview" | "createAutomation" | "createPipeline">("overview");
  const [kind, setKind] = useState<"recurringMessage" | "scheduledMessage" | "calendarMessage">("recurringMessage");
  const [name, setName] = useState("");
  const [threadId, setThreadId] = useState(threads[0]?.id || "");
  const [prompt, setPrompt] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [runAt, setRunAt] = useState("");
  const [time, setTime] = useState("09:00");
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [fromCategory, setFromCategory] = useState(categories[0] || "");
  const [toCategory, setToCategory] = useState(categories[1] || categories[0] || "");
  const [pipelineTiming, setPipelineTiming] = useState<"delay" | "scheduled">("delay");
  const [busy, setBusy] = useState(false);
  async function create() {
    const interval = Number.parseInt(minutes, 10);
    let input: CreateAutomationInput;
    if (view === "createPipeline") input = pipelineTiming === "delay"
      ? { name: name.trim(), action: { kind: "categoryPipeline", fromCategory, toCategory, afterMinutes: interval } }
      : { name: name.trim(), action: { kind: "scheduledCategoryPipeline", fromCategory, toCategory, runAt: parseLocalDateTime(runAt) } };
    else if (kind === "recurringMessage") input = { name: name.trim(), action: { kind, threadId, prompt: prompt.trim(), everyMinutes: interval, startInMinutes: interval } };
    else if (kind === "scheduledMessage") input = { name: name.trim(), action: { kind, threadId, prompt: prompt.trim(), runAt: parseLocalDateTime(runAt) } };
    else { const [hour, minute] = time.split(":").map(Number); input = { name: name.trim(), action: { kind, threadId, prompt: prompt.trim(), weekdays, minuteOfDay: hour * 60 + minute, timezoneOffsetMinutes: new Date().getTimezoneOffset() } }; }
    setBusy(true);
    try { await api.createAutomation(input); setName(""); setPrompt(""); setRunAt(""); onChanged(); setView("overview"); }
    catch (error) { Alert.alert("Could not create automation", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const creatingPipeline = view === "createPipeline";
  const validSchedule = creatingPipeline
    ? pipelineTiming === "delay" ? Number(minutes) >= 1 : parseLocalDateTime(runAt) > Date.now()
    : kind === "scheduledMessage" ? parseLocalDateTime(runAt) > Date.now() : kind !== "calendarMessage" || weekdays.length > 0;
  const valid = name.trim() && validSchedule && (creatingPipeline
    ? fromCategory && toCategory && fromCategory !== toCategory
    : threadId && prompt.trim() && (kind !== "recurringMessage" || Number(minutes) >= 1));
  return <Modal animationType="slide"><SafeAreaView style={styles.page}>
    <View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel={view === "overview" ? "Close workflows" : "Back to workflows"} style={styles.chatBackButton} onPress={view === "overview" ? onClose : () => setView("overview")}><Text style={view === "overview" ? styles.closeIcon : styles.back}>{view === "overview" ? "×" : "‹"}</Text></Pressable><View style={styles.headerCopy}><Text style={styles.headerTitle}>{view === "overview" ? "Workflows" : creatingPipeline ? "New pipeline" : "New automation"}</Text><Text style={styles.headerMeta}>{view === "overview" ? "Schedules running on your PC" : creatingPipeline ? "Schedule category movement" : "Schedule a Codex prompt"}</Text></View></View>
    {view === "overview" ? <ScrollView contentContainerStyle={styles.manager}>
      <View style={styles.managerIntro}><Text style={styles.overviewEyebrow}>ORCHESTRATION</Text><Text style={styles.managerTitle}>Your workflows</Text><Text style={styles.managerSubtitle}>Automations send prompts. Pipelines move tasks between categories.</Text></View>
      <View style={styles.workflowCreateChoices}><Pressable style={styles.workflowCreateCard} onPress={() => setView("createAutomation")}><View style={styles.automationIcon}><Text>⚡</Text></View><View style={styles.categoryCopy}><Text style={styles.automationName}>New automation</Text><Text style={styles.automationDescription}>Schedule a prompt for a task</Text></View><Text style={styles.openArrow}>→</Text></Pressable><Pressable style={styles.workflowCreateCard} onPress={() => setView("createPipeline")}><View style={styles.automationIcon}><Text>→</Text></View><View style={styles.categoryCopy}><Text style={styles.automationName}>New pipeline</Text><Text style={styles.automationDescription}>Move tasks after a delay or on a date</Text></View><Text style={styles.openArrow}>→</Text></Pressable></View>
      {automations.length === 0 && <View style={styles.automationEmpty}><Text style={styles.emptyIcon}>◇</Text><Text style={styles.emptyTitle}>No workflows yet</Text><Text style={styles.emptyText}>Choose automation or pipeline above to create the first one.</Text></View>}
      {automations.map((automation) => <View key={automation.id} style={styles.automationCard}><View style={styles.automationCardTop}><View style={styles.automationIcon}><Text>{automation.action.kind === "categoryPipeline" || automation.action.kind === "scheduledCategoryPipeline" ? "→" : automation.action.kind === "scheduledMessage" ? "◷" : "↻"}</Text></View><View style={styles.categoryCopy}><Text style={styles.automationName}>{automation.name}</Text><Text style={styles.automationDescription}>{automationDescription(automation, threads)}</Text>{automation.lastError && <Text style={styles.automationError}>{automation.lastError}</Text>}</View><Pressable style={[styles.toggle, automation.enabled && styles.toggleOn]} onPress={() => void api.setAutomationEnabled(automation.id, !automation.enabled).then(onChanged)}><View style={[styles.toggleKnob, automation.enabled && styles.toggleKnobOn]} /></Pressable></View><Pressable onPress={() => Alert.alert("Delete workflow?", automation.name, [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => void api.deleteAutomation(automation.id).then(onChanged) }])}><Text style={styles.deleteAutomation}>Delete</Text></Pressable></View>)}
    </ScrollView> : <ScrollView contentContainerStyle={styles.manager}>
      <View style={styles.managerIntro}><Text style={styles.overviewEyebrow}>{creatingPipeline ? "NEW PIPELINE" : "NEW AUTOMATION"}</Text><Text style={styles.managerTitle}>{creatingPipeline ? "Move work automatically" : "Schedule a Codex prompt"}</Text><Text style={styles.managerSubtitle}>{creatingPipeline ? "Move every task in a category after time spent there or at a specific date." : "Run once, repeat on an interval or use a weekly calendar."}</Text></View>
      <View style={styles.automationComposer}><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.automationModes}>{(creatingPipeline ? [["delay","After time"],["scheduled","Specific date"]] : [["recurringMessage","Interval"],["scheduledMessage","Once"],["calendarMessage","Calendar"]]).map(([value,label])=><Pressable key={value} style={[styles.automationMode,(creatingPipeline ? pipelineTiming===value : kind===value)&&styles.automationModeActive]} onPress={()=>creatingPipeline?setPipelineTiming(value as typeof pipelineTiming):setKind(value as typeof kind)}><Text style={[styles.segmentText,(creatingPipeline ? pipelineTiming===value : kind===value)&&styles.segmentTextActive]}>{label}</Text></Pressable>)}</ScrollView>
        <TextInput style={styles.smallInput} value={name} onChangeText={setName} placeholder={creatingPipeline ? "Pipeline name" : "Automation name"} />
        {!creatingPipeline ? <><Text style={styles.fieldLabel}>TASK</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.miniChoices}>{threads.map((thread) => <Pressable key={thread.id} style={[styles.miniChoice, thread.id === threadId && styles.miniChoiceActive]} onPress={() => setThreadId(thread.id)}><Text numberOfLines={1} style={[styles.miniChoiceText, thread.id === threadId && styles.miniChoiceTextActive]}>{displayTitle(thread.name, thread.preview)}</Text></Pressable>)}</ScrollView><TextInput style={[styles.smallInput, styles.promptInput]} value={prompt} onChangeText={setPrompt} multiline placeholder="What should Codex do?" /></> : <><Text style={styles.fieldLabel}>FROM CATEGORY</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.miniChoices}>{categories.map((category) => <Pressable key={category} style={[styles.miniChoice, category === fromCategory && styles.miniChoiceActive]} onPress={() => setFromCategory(category)}><Text style={[styles.miniChoiceText, category === fromCategory && styles.miniChoiceTextActive]}>{category}</Text></Pressable>)}</ScrollView><Text style={styles.fieldLabel}>TO CATEGORY</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.miniChoices}>{categories.map((category) => <Pressable key={category} style={[styles.miniChoice, category === toCategory && styles.miniChoiceActive]} onPress={() => setToCategory(category)}><Text style={[styles.miniChoiceText, category === toCategory && styles.miniChoiceTextActive]}>{category}</Text></Pressable>)}</ScrollView></>}
        {((!creatingPipeline && kind === "recurringMessage") || (creatingPipeline && pipelineTiming === "delay")) && <><Text style={styles.fieldLabel}>{creatingPipeline ? "MOVE AFTER (MINUTES)" : "REPEAT EVERY (MINUTES)"}</Text><TextInput style={styles.smallInput} value={minutes} onChangeText={setMinutes} keyboardType="number-pad" /></>}
        {creatingPipeline && pipelineTiming === "scheduled" && <><Text style={styles.fieldLabel}>MOVE ON (YYYY-MM-DD HH:MM)</Text><TextInput style={styles.smallInput} value={runAt} onChangeText={setRunAt} placeholder="2026-08-14 09:30" /></>}
        {!creatingPipeline && kind === "scheduledMessage" && <><Text style={styles.fieldLabel}>RUN ONCE (YYYY-MM-DD HH:MM)</Text><TextInput style={styles.smallInput} value={runAt} onChangeText={setRunAt} placeholder="2026-08-14 09:30" /></>}
        {!creatingPipeline && kind === "calendarMessage" && <><Text style={styles.fieldLabel}>TIME (HH:MM)</Text><TextInput style={styles.smallInput} value={time} onChangeText={setTime} placeholder="09:00" keyboardType="numbers-and-punctuation" /><View style={styles.mobileWeekdays}>{[[1,"M"],[2,"T"],[3,"W"],[4,"T"],[5,"F"],[6,"S"],[0,"S"]].map(([day,label])=><Pressable key={day} style={[styles.mobileWeekday,weekdays.includes(day as number)&&styles.miniChoiceActive]} onPress={()=>setWeekdays(current=>current.includes(day as number)?current.filter(value=>value!==day):[...current,day as number])}><Text style={styles.miniChoiceText}>{label}</Text></Pressable>)}</View></>}
        <Pressable disabled={!valid || busy} style={[styles.primaryButton, (!valid || busy) && styles.disabled]} onPress={() => void create()}>{busy ? <ActivityIndicator color="white" /> : <Text style={styles.primaryButtonText}>{creatingPipeline ? "Create pipeline" : "Create automation"}</Text>}</Pressable>
      </View>
    </ScrollView>}
  </SafeAreaView></Modal>;
}

function Board({ credential, onDisconnect, onOpenTour }: { credential: PairingCredential; onDisconnect: () => Promise<void>; onOpenTour: () => void }) {
  const api = useMemo(() => new BoardApi(credential), [credential]);
  const [threads, setThreads] = useState<ThreadDto[]>([]);
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});
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
  const [choosingProject, setChoosingProject] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState(ALL_PROJECTS);
  const [search, setSearch] = useState("");
  const [connected, setConnected] = useState(false);
  const [rateLimits, setRateLimits] = useState<JsonValue | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [eventRevision, setEventRevision] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notificationIds = useRef<Set<string> | null>(null);
  const pendingCreatedThreads = useRef(new Map<string, ThreadDto>());
  const refresh = useCallback(async () => {
    try {
      const [nextThreads, nextConfig, nextQueues, nextRequests, nextAutomations, nextNotifications, nextRateLimits] = await Promise.all([api.threads(), api.board(), api.queues(), api.requests(), api.automations().catch(() => []), api.notifications().catch(() => []), api.rateLimits().catch(() => null)]);
      const fetchedIds = new Set(nextThreads.map((thread) => thread.id));
      for (const id of fetchedIds) pendingCreatedThreads.current.delete(id);
      const mergedThreads = [...nextThreads, ...[...pendingCreatedThreads.current].filter(([id]) => !fetchedIds.has(id)).map(([, thread]) => thread)];
      setThreads(mergedThreads); setConfig(nextConfig); setQueues(nextQueues); setRequests(nextRequests); setAutomations(nextAutomations); setNotifications(nextNotifications);
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
  useEffect(() => { void loadSelectedBoard().then((saved) => { if (saved) setSelectedProject(saved); }); }, []);
  const discovered = [...new Set(threads.map((thread) => categoryFromTitle(thread.name)))];
  const categories = [...(config?.categories || []), ...discovered.filter((value) => !config?.categories.includes(value))];
  const projects = useMemo(() => projectBoards(threads), [threads]);
  const projectThreads = selectedProject === ALL_PROJECTS ? threads : threads.filter((thread) => projectKey(thread.cwd) === selectedProject);
  const dashboardCategories = categories.filter((category) => projectThreads.some((thread) => categoryFromTitle(thread.name) === category));
  useEffect(() => { if (!loading && selectedProject !== ALL_PROJECTS && !projects.some((project) => project.key === selectedProject)) { setSelectedProject(ALL_PROJECTS); void saveSelectedBoard(ALL_PROJECTS); } }, [loading, selectedProject, projects.map((project) => project.key).join("\u0000")]);
  useEffect(() => {
    if (dashboardCategories.length > 0 && (!activeCategory || !dashboardCategories.includes(activeCategory))) setActiveCategory(dashboardCategories[0]);
  }, [activeCategory, dashboardCategories.join("\u0000")]);
  const visibleCategory = activeCategory && dashboardCategories.includes(activeCategory) ? activeCategory : dashboardCategories[0];
  const visibleThreads = projectThreads.filter((thread) => categoryFromTitle(thread.name) === visibleCategory);
  const searchedThreads = visibleThreads.filter((thread) => {
    const query = search.trim().toLocaleLowerCase();
    return !query || [displayTitle(thread.name, thread.preview), thread.preview || "", projectLabel(thread.cwd)].some((value) => value.toLocaleLowerCase().includes(query));
  });
  const workingCount = projectThreads.filter(isWorking).length;
  const selectedProjectLabel = selectedProject === ALL_PROJECTS ? "All projects" : projects.find((project) => project.key === selectedProject)?.label || "Project";
  async function archiveThread(thread: ThreadDto) {
    const title = displayTitle(thread.name, thread.preview);
    Alert.alert("Archive task", `Archive “${title}”?`, [{ text: "Cancel", style: "cancel" }, { text: "Archive", style: "destructive", onPress: () => void api.archive(thread.id).then(() => { if (selected?.id === thread.id) setSelected(null); return refresh(); }).catch((error) => Alert.alert("Could not archive task", String(error))) }]);
  }
  async function archiveProject(project: { key: string; label: string }) {
    const items = threads.filter((thread) => projectKey(thread.cwd) === project.key);
    Alert.alert("Archive project", `Archive ${items.length} tasks from “${project.label}”?`, [{ text: "Cancel", style: "cancel" }, { text: "Archive", style: "destructive", onPress: () => void Promise.all(items.map((thread) => api.archive(thread.id))).then(() => { setChoosingProject(false); setSelectedProject(ALL_PROJECTS); return refresh(); }).catch((error) => Alert.alert("Could not archive project", String(error))) }]);
  }
  async function stopThread(thread: ThreadDto) {
    try { const loaded = await api.thread(thread.id); const turnId = activeTurnId(loaded); if (turnId) await api.interrupt(thread.id, turnId); else Alert.alert("Thread changed", "The active turn is no longer available."); await refresh(); }
    catch (error) { Alert.alert("Could not stop task", error instanceof Error ? error.message : String(error)); }
  }
  function selectProjectBoard(key: string) {
    setSelectedProject(key);
    setSearch("");
    setActiveCategory(null);
    void saveSelectedBoard(key);
  }

  function retainCreatedThread(thread: ThreadDto) {
    pendingCreatedThreads.current.set(thread.id, thread);
    setThreads((current) => current.some((item) => item.id === thread.id) ? current : [thread, ...current]);
    setSelected(thread);
  }

  return <SafeAreaView style={styles.page}>
    <MobileBoardHome
      connected={connected}
      loading={loading}
      projectLabel={selectedProjectLabel}
      showProject={selectedProject === ALL_PROJECTS}
      totalCount={projectThreads.length}
      workingCount={workingCount}
      usage={usageSnapshot(rateLimits)}
      unreadCount={notifications.filter(item=>!item.read).length}
      categories={dashboardCategories.map(category=>({name:category,count:projectThreads.filter(thread=>categoryFromTitle(thread.name)===category).length}))}
      activeCategory={visibleCategory||""}
      threads={searchedThreads}
      queues={queues}
      search={search}
      isWorking={isWorking}
      titleFor={(thread)=>displayTitle(thread.name,thread.preview)}
      projectFor={(thread)=>projectLabel(thread.cwd)}
      onSearch={setSearch}
      onProject={()=>setChoosingProject(true)}
      onCategory={setActiveCategory}
      onOpen={setSelected}
      onMove={setMoving}
      onFork={setForking}
      onRename={setRenaming}
      onArchive={archiveThread}
      onStop={stopThread}
      onNewTask={()=>setCreatingTask(true)}
      onInbox={()=>setInboxOpen(true)}
      onAutomations={()=>setAutomating(true)}
      onSettings={()=>setManaging(true)}
    />
    {automationAlert&&<Pressable style={styles.mobileAutomationAlert} onPress={()=>{setAutomationAlert(null);setResultNotification(automationAlert);void api.markNotificationsRead(automationAlert.id)}}><View style={styles.mobileAutomationAlertIcon}><Text>⚡</Text></View><View style={styles.categoryCopy}><Text style={styles.automationName}>Automation completed</Text><Text style={styles.automationDescription}>{automationAlert.automation?.name}</Text></View><Text style={styles.openArrow}>→</Text></Pressable>}
    {selected && <Chat thread={selected} api={api} queue={queues[selected.id] || []} requests={requests.filter((request) => requestThreadId(request) === selected.id)} eventRevision={eventRevision} onClose={() => setSelected(null)} onChanged={refresh} onFork={() => setForking(selected)} onRename={()=>setRenaming(selected)} />}
    {managing && config && <CategoryManager config={config} threads={threads} api={api} onClose={() => setManaging(false)} onSaved={refresh} onOpenTour={onOpenTour} onDisconnect={() => void onDisconnect()} />}
    {automating && <AutomationManager api={api} automations={automations} threads={threads} categories={categories} onClose={() => setAutomating(false)} onChanged={refresh} />}
    {choosingProject && <ChoiceModal title="Choose a board" subtitle="Open a project dashboard or the complete overview." options={[{ key: ALL_PROJECTS, label: "All projects", meta: `${threads.length} tasks · overview` }, ...projects.map((project) => ({ key: project.key, label: project.label, meta: `${project.count} ${project.count === 1 ? "task" : "tasks"}` }))]} selected={selectedProject} onSelect={selectProjectBoard} onArchiveProject={(option) => archiveProject(option)} onClose={() => setChoosingProject(false)} />}
    {creatingTask && <NewTaskModal api={api} threads={threads} categories={categories} defaultProjectKey={selectedProject === ALL_PROJECTS ? undefined : selectedProject} onClose={() => setCreatingTask(false)} onCreated={(thread) => { setCreatingTask(false); retainCreatedThread(thread); void refresh(); }} />}
    {inboxOpen && <InboxModal api={api} items={notifications} onClose={()=>setInboxOpen(false)} onChanged={refresh} onOpenResult={(item)=>{setInboxOpen(false);setResultNotification(item)}} onOpen={(id)=>{const thread=threads.find(item=>item.id===id);if(thread){setInboxOpen(false);setSelected(thread)}}}/>}
    {moving && <MoveDialog thread={moving} categories={categories} api={api} onClose={() => setMoving(null)} onMoved={refresh} />}
    {forking && <ForkThreadModal api={api} thread={forking} categories={categories} onClose={()=>setForking(null)} onCreated={(thread)=>{setForking(null);setSelected(thread);void refresh()}}/>}
    {renaming&&<RenameThreadModal key={renaming.id} api={api} thread={renaming} onClose={()=>setRenaming(null)} onSaved={(saved)=>{setThreads(current=>current.map(item=>item.id===saved.id?saved:item));setSelected(current=>current?.id===saved.id?saved:current);setRenaming(null);void refresh()}}/>}
    {resultNotification&&<AutomationResultModal notification={resultNotification} onClose={()=>setResultNotification(null)} onOpenThread={(id)=>{const thread=threads.find(item=>item.id===id);setResultNotification(null);if(thread)setSelected(thread)}}/>}
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
  page: { flex: 1, backgroundColor: "#F4F5F9" }, center: { flex: 1, alignItems: "center", justifyContent: "center" },
  pairPage: { flex: 1, padding: 24, justifyContent: "center", backgroundColor: "#F4F5F9" }, pairHero: { alignItems: "center", marginBottom: 22 }, pairCard: { padding: 18, borderWidth: 1, borderColor: "#E1E3EB", borderRadius: 20, backgroundColor: "white", shadowColor: "#171923", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.07, shadowRadius: 20, elevation: 3 }, logo: { width: 58, height: 58, borderRadius: 17, backgroundColor: "#1B1E2B", flexDirection: "row", alignItems: "flex-end", gap: 4, padding: 13, alignSelf: "center" }, logoBar: { flex: 1, borderRadius: 2, backgroundColor: "white" },
  pairEyebrow: { marginTop: 19, color: "#6266EA", fontSize: 9, fontWeight: "800", letterSpacing: 1.4 }, pairFootnote: { marginTop: 16, textAlign: "center", color: "#8A8F9C", fontSize: 10, lineHeight: 15 }, connectButton: { marginTop: 10 },
  title: { marginTop: 20, textAlign: "center", fontSize: 30, fontWeight: "800", letterSpacing: -1, color: "#171923" }, subtitle: { marginVertical: 12, textAlign: "center", color: "#747987", fontSize: 14, lineHeight: 21 }, or: { margin: 16, textAlign: "center", color: "#969BA7", fontSize: 11, fontWeight: "600" },
  primaryButton: { minHeight: 52, marginTop: 12, borderRadius: 14, backgroundColor: "#6266EA", alignItems: "center", justifyContent: "center", paddingHorizontal: 18 }, compactButton: { minHeight: 42 }, primaryButtonText: { color: "white", fontWeight: "700" }, secondaryButton: { minHeight: 46, borderRadius: 12, backgroundColor: "white", alignItems: "center", justifyContent: "center", paddingHorizontal: 22 }, disabled: { opacity: 0.45 },
  input: { minHeight: 82, borderWidth: 1, borderColor: "#d7d9df", borderRadius: 12, padding: 12, backgroundColor: "white", textAlignVertical: "top" }, smallInput: { minHeight: 42, borderWidth: 1, borderColor: "#d7d9df", borderRadius: 9, padding: 10, backgroundColor: "white" },
  scanner: { flex: 1, backgroundColor: "black" }, scannerOverlay: { flex: 1, alignItems: "center", justifyContent: "space-between", padding: 28 }, scannerTitle: { color: "white", fontSize: 20, fontWeight: "700" }, scanFrame: { width: 250, height: 250, borderWidth: 3, borderColor: "white", borderRadius: 22 },
  header: { minHeight: 70, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: "#DFE1E8", backgroundColor: "white" }, headerCopy: { flex: 1 }, headerTitle: { maxWidth: "76%", color: "#171923", fontSize: 17, fontWeight: "800", letterSpacing: -0.35 }, headerMeta: { marginTop: 3, color: "#858A96", fontSize: 10 }, headerAction: { color: "#6266EA", fontSize: 12, fontWeight: "700" }, back: { color: "#6266EA", fontSize: 20, lineHeight: 20, includeFontPadding: false, textAlignVertical: "center" }, stop: { color: "#B6473A", fontSize: 11, fontWeight: "800" }, topbarActions:{flexDirection:"row",alignItems:"center",gap:7},topbarIconButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 12, borderWidth: 1, borderColor: "#E1E3EA", backgroundColor: "#FAFAFC" }, topbarForkIcon:{color:"#6266EA",fontSize:21,lineHeight:22},topbarIconDanger: { borderColor: "#F0D5D1", backgroundColor: "#FFF0ED" }, stopIcon: { color: "#B6473A", fontSize: 12 }, readAllIcon: { color: "#6266EA", fontSize: 13, fontWeight: "800", letterSpacing: -3 },
  columns: { padding: 14, gap: 12 }, column: { width: 310, borderRadius: 14, backgroundColor: "#e9ebef", padding: 10 }, columnHeader: { height: 42, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4 }, columnTitle: { color: "#31343b", fontSize: 13, fontWeight: "700" }, count: { color: "#777d88", backgroundColor: "white", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, fontSize: 11 },
  card: { marginBottom: 13, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: "#E2E4EC", backgroundColor: "white", shadowColor: "#171923", shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.06, shadowRadius: 14, elevation: 2 }, workingCard: { borderColor: "#9295F2", borderLeftWidth: 4 }, cardTitle: { color: "#171923", fontSize: 17, lineHeight: 22, fontWeight: "700", letterSpacing: -0.3 }, cardPreview: { marginTop: 8, color: "#747987", fontSize: 13, lineHeight: 19 }, cardStatus: { color: "#6266EA", fontSize: 11, fontWeight: "700" }, workingText: { color: "#6266EA" }, empty: { textAlign: "center", color: "#777", marginTop: 50 },
  chat: { flex: 1 }, chatContent: { padding: 16, paddingBottom: 22, gap: 11 }, bubble: { maxWidth: "90%", borderRadius: 17, paddingHorizontal: 15, paddingVertical: 12 }, bubble_user: { alignSelf: "flex-end", backgroundColor: "#6266EA", borderBottomRightRadius: 5 }, bubble_assistant: { alignSelf: "flex-start", backgroundColor: "white", borderBottomLeftRadius: 5, borderWidth: 1, borderColor: "#E4E6ED" }, bubble_activity: { alignSelf: "stretch", maxWidth: "100%", backgroundColor: "#ECEEF4", borderRadius: 12 }, bubbleLabel: { marginBottom: 7, color: "#858A96", fontSize: 8, fontWeight: "800", letterSpacing: 1 }, bubbleText: { color: "#252832", fontSize: 14, lineHeight: 21 }, userText: { color: "white" },
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
  resultLink: { marginTop: 5, color: "#6266EA", fontSize: 9, fontWeight: "700" }, mobileAutomationAlert: { position: "absolute", zIndex: 50, top: 82, left: 14, right: 14, minHeight: 68, padding: 12, flexDirection: "row", alignItems: "center", gap: 11, borderWidth: 1, borderColor: "#C8CAF7", borderRadius: 15, backgroundColor: "white", shadowColor: "#171923", shadowOffset: { width: 0, height: 9 }, shadowOpacity: .16, shadowRadius: 24, elevation: 8 }, mobileAutomationAlertIcon: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: "#EEEFFF" },
  tourMobile: { flex: 1, backgroundColor: "#F5F6FA" }, tourMobileArt: { flex: 1.05, alignItems: "center", justifyContent: "center", gap: 30, backgroundColor: "#1B1E2B" }, tourMiniBoard: { width: "78%", height: 170, padding: 12, flexDirection: "row", gap: 8, borderRadius: 18, backgroundColor: "rgba(255,255,255,.08)" }, tourMiniColumn: { flex: 1, borderRadius: 11, backgroundColor: "rgba(255,255,255,.16)" }, tourMobileCopy: { flex: .95, padding: 28, justifyContent: "center" }, tourMobileTitle: { marginTop: 8, color: "#171923", fontSize: 30, lineHeight: 35, fontWeight: "800", letterSpacing: -1 }, tourMobileText: { marginTop: 12, color: "#747987", fontSize: 14, lineHeight: 22 }, tourMobileDots: { marginTop: 25, marginBottom: 10, flexDirection: "row", gap: 6 }, tourMobileDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#D3D5DE" }, tourMobileDotActive: { width: 24, backgroundColor: "#6266EA" },
  projectFilter: { minHeight: 50, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: "#E0E2E9", borderRadius: 13, backgroundColor: "white" }, projectFilterLabel: { color: "#969AA6", fontSize: 8, fontWeight: "800", letterSpacing: 1 }, projectFilterValue: { marginTop: 3, color: "#292C35", fontSize: 13, fontWeight: "700" }, projectFilterChevron: { color: "#6266EA", fontSize: 19 },
  categoryTabsScroll: { flexGrow: 0, flexShrink: 0, height: 52 }, categoryTabs: { height: 52, paddingHorizontal: 16, paddingBottom: 10, alignItems: "center", gap: 8 }, categoryTab: { height: 38, paddingLeft: 14, paddingRight: 7, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 19, borderWidth: 1, borderColor: "#E0E2E9", backgroundColor: "white" }, categoryTabActive: { borderColor: "#1B1E2B", backgroundColor: "#1B1E2B" }, categoryTabText: { color: "#686D7A", fontSize: 12, fontWeight: "700" }, categoryTabTextActive: { color: "white" }, categoryTabCount: { minWidth: 23, height: 23, paddingHorizontal: 6, textAlign: "center", textAlignVertical: "center", borderRadius: 12, overflow: "hidden", color: "#6F7481", backgroundColor: "#F0F1F5", fontSize: 10, fontWeight: "800" }, categoryTabCountActive: { color: "#1B1E2B", backgroundColor: "white" },
  taskList: { flex: 1 }, taskListContent: { paddingHorizontal: 16, paddingBottom: 28 }, listHeading: { marginTop: 7, marginBottom: 12, paddingHorizontal: 3, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, listTitle: { color: "#242630", fontSize: 14, fontWeight: "800" }, listCount: { color: "#858A96", fontSize: 10, fontWeight: "600" },
  cardTop: { minHeight: 24, marginBottom: 9, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, projectPill: { maxWidth: "68%", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 7, overflow: "hidden", color: "#747987", backgroundColor: "#F1F2F6", fontSize: 9, fontWeight: "700" }, workingPill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: "#EEEFFF" }, workingPillText: { color: "#6266EA", fontSize: 9, fontWeight: "800" }, cardBottom: { marginTop: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, openArrow: { color: "#6266EA", fontSize: 18, fontWeight: "700" }, moveLinkText: { color: "#858A96", fontSize: 10, fontWeight: "700" },
  emptyColumn: { minHeight: 240, marginTop: 5, alignItems: "center", justifyContent: "center", borderWidth: 1, borderStyle: "dashed", borderColor: "#D8DAE3", borderRadius: 18, backgroundColor: "rgba(255,255,255,.45)" }, emptyIcon: { color: "#A1A5B1", fontSize: 31 }, emptyTitle: { marginTop: 9, color: "#333640", fontSize: 15, fontWeight: "700" }, emptyText: { maxWidth: 230, marginTop: 5, textAlign: "center", color: "#858A96", fontSize: 11, lineHeight: 17 },
  chatBackButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 12, borderWidth: 1, borderColor: "#E1E3EA", backgroundColor: "#FAFAFC" }, chatTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 }, chatState: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8, backgroundColor: "#F0F1F5" }, chatStateLive: { backgroundColor: "#EEEFFF" }, chatStateText: { color: "#7C818E", fontSize: 8, fontWeight: "800" }, chatStateTextLive: { color: "#6266EA" }, stopButton: { paddingHorizontal: 11, paddingVertical: 8, borderRadius: 10, backgroundColor: "#FFF0ED" },
  choiceDialog: { maxHeight: "78%", padding: 20, paddingTop: 10, borderRadius: 24, backgroundColor: "#F8F8FB" }, choiceList: { marginTop: 16 }, choiceRow: { minHeight: 60, marginBottom: 8, paddingHorizontal: 15, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: "#E1E3EA", borderRadius: 14, backgroundColor: "white" }, choiceRowSelected: { borderColor: "#8D90ED", backgroundColor: "#F1F1FF" }, choiceMain: { flex: 1, minHeight: 58, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, archiveProjectButton: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: 9, backgroundColor: "#FDEDEC" }, archiveIcon: { color: "#B54A3C", fontSize: 18, lineHeight: 20 }, choiceLabel: { color: "#262832", fontSize: 14, fontWeight: "700" }, choiceCheck: { color: "#6266EA", fontSize: 17, fontWeight: "800" },
  forkSourceMobile:{padding:14,borderRadius:13,backgroundColor:"white",borderWidth:1,borderColor:"#E1E3EA"},forkHistoryChoice:{minHeight:58,marginBottom:8,paddingHorizontal:14,flexDirection:"row",alignItems:"center",justifyContent:"space-between",borderWidth:1,borderColor:"#E1E3EA",borderRadius:13,backgroundColor:"white"},forkHistoryChoiceActive:{borderColor:"#8D90ED",backgroundColor:"#F1F1FF"},forkHistoryLabel:{flex:1,paddingRight:10,color:"#3A3D48",fontSize:12,lineHeight:17,fontWeight:"600"},forkNoteMobile:{marginVertical:8,color:"#7C818E",fontSize:11,lineHeight:17},
  automationHeaderNew: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: "#1B1E2B" }, automationHeaderNewIcon: { color: "white", fontSize: 20, lineHeight: 22, fontWeight: "600" }, workflowCreateChoices: { gap: 9, marginBottom: 20 }, workflowCreateCard: { minHeight: 68, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 11, borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 15, backgroundColor: "white" }, automationEmpty: { minHeight: 260, alignItems: "center", justifyContent: "center", borderWidth: 1, borderStyle: "dashed", borderColor: "#D8DAE3", borderRadius: 18, backgroundColor: "rgba(255,255,255,.45)" }, automationComposer: { padding: 14, gap: 10, borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 17, backgroundColor: "white" }, segmented: { padding: 3, flexDirection: "row", borderRadius: 12, backgroundColor: "#EFF0F4" }, segment: { flex: 1, minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: 9 }, segmentActive: { backgroundColor: "#1B1E2B" }, segmentText: { color: "#727784", fontSize: 11, fontWeight: "700" }, segmentTextActive: { color: "white" }, fieldLabel: { marginTop: 5, color: "#8A8F9B", fontSize: 8, fontWeight: "800", letterSpacing: 1 }, miniChoices: { gap: 7 }, miniChoice: { maxWidth: 190, minHeight: 36, paddingHorizontal: 11, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#E0E2E9", borderRadius: 11, backgroundColor: "#F9F9FB" }, miniChoiceActive: { borderColor: "#8588EC", backgroundColor: "#EEEFFF" }, miniChoiceText: { color: "#696E7B", fontSize: 10, fontWeight: "700" }, miniChoiceTextActive: { color: "#5559D8" }, promptInput: { minHeight: 76, textAlignVertical: "top" }, automationSectionTitle: { marginTop: 24, marginBottom: 10, marginLeft: 3, color: "#858A96", fontSize: 9, fontWeight: "800", letterSpacing: 1 }, automationCard: { marginBottom: 10, padding: 14, borderWidth: 1, borderColor: "#E1E3EA", borderRadius: 15, backgroundColor: "white" }, automationCardTop: { flexDirection: "row", alignItems: "center", gap: 11 }, automationIcon: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 11, backgroundColor: "#EEEFFF" }, automationName: { color: "#252832", fontSize: 13, fontWeight: "800" }, automationDescription: { marginTop: 3, color: "#7F8491", fontSize: 10, lineHeight: 15 }, automationError: { marginTop: 4, color: "#B54A3C", fontSize: 9 }, toggle: { width: 42, height: 24, padding: 3, justifyContent: "center", borderRadius: 12, backgroundColor: "#D8DAE1" }, toggleOn: { backgroundColor: "#6266EA" }, toggleKnob: { width: 18, height: 18, borderRadius: 9, backgroundColor: "white" }, toggleKnobOn: { alignSelf: "flex-end" }, deleteAutomation: { marginTop: 10, alignSelf: "flex-end", color: "#B54A3C", fontSize: 10, fontWeight: "700" },
  mobileChatToolbar: { flexDirection: "row", gap: 9, paddingHorizontal: 11, paddingTop: 9, backgroundColor: "white" }, mobileToolButton: { flex: 1, minWidth: 0, minHeight: 42, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 7, borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 11, backgroundColor: "#FAFAFC" }, mobileToolLabel: { color: "#858A96", fontSize: 9, fontWeight: "800" }, mobileToolValue: { flex: 1, minWidth: 0, color: "#5559D8", fontSize: 10, fontWeight: "800" }, mobileToolChevron: { color: "#858A96", fontSize: 16 }, mobileAttachmentButton: { width: 94, minHeight: 42, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 11, backgroundColor: "#FAFAFC" }, mobileAttachmentIcon: { color: "#5559D8", fontSize: 18, lineHeight: 20 }, mobileAttachmentLabel: { color: "#5559D8", fontSize: 10, fontWeight: "800" }, modelRequiredHint: { marginHorizontal: 13, marginTop: 5, color: "#A4493D", fontSize: 9, fontWeight: "700" }, toolModalBackdrop: { flex: 1, justifyContent: "flex-end", padding: 10, backgroundColor: "rgba(18,20,28,.42)" }, toolModal: { maxHeight: "88%", padding: 16, borderRadius: 20, backgroundColor: "#F8F8FA" }, attachModal: { padding: 16, borderRadius: 20, backgroundColor: "#F8F8FA" }, toolModalHeader: { marginBottom: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }, toolModalTitle: { color: "#1B1E2B", fontSize: 16, fontWeight: "800" }, toolModalSubtitle: { marginTop: 4, color: "#858A96", fontSize: 10 }, modalCloseButton: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: "#ECEEF3" }, modelOptionList: { maxHeight: 250, marginBottom: 7, padding: 3, borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 12, backgroundColor: "white" }, modelOption: { minHeight: 50, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 9 }, modelOptionSelected: { backgroundColor: "#EEEFFF" }, modelOptionCopy: { flex: 1, minWidth: 0 }, modelOptionName: { color: "#252832", fontSize: 11, fontWeight: "800" }, modelOptionId: { marginTop: 2, color: "#858A96", fontSize: 8 }, modelOptionCheck: { color: "#5559D8", fontSize: 16, fontWeight: "800" }, toolSectionLabel: { marginTop: 10, marginBottom: 7, color: "#858A96", fontSize: 8, fontWeight: "900", letterSpacing: 1 }, toolChoiceRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 }, toolChoice: { minHeight: 30, paddingHorizontal: 10, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 9, backgroundColor: "white" }, toolChoiceSelected: { borderColor: "#777BE9", backgroundColor: "#EEEFFF" }, toolChoiceText: { color: "#717684", fontSize: 9, fontWeight: "700" }, toolChoiceTextSelected: { color: "#5559D8" }, toolModalFooter: { marginTop: 16, flexDirection: "row", justifyContent: "space-between", gap: 8 }, compactMobileButton: { minHeight: 40, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 10, backgroundColor: "white" }, compactMobileText: { color: "#5559D8", fontSize: 10, fontWeight: "800" }, toolDoneButton: { minHeight: 40, minWidth: 76, paddingHorizontal: 14, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: "#1B1E2B" }, toolDoneText: { color: "white", fontSize: 10, fontWeight: "800" }, attachChoice: { minHeight: 64, marginBottom: 4, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 11, borderWidth: 1, borderColor: "#E0E2EA", borderRadius: 13, backgroundColor: "white" }, attachChoiceIcon: { width: 36, height: 36, textAlign: "center", textAlignVertical: "center", borderRadius: 11, overflow: "hidden", color: "#5559D8", backgroundColor: "#EEEFFF", fontSize: 21 }, attachChoiceTitle: { color: "#252832", fontSize: 11, fontWeight: "800" }, attachChoiceSubtitle: { marginTop: 4, color: "#858A96", fontSize: 9 }, settingsRow: { minHeight: 64, marginBottom: 8, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: "#E2E4EC", borderRadius: 13, backgroundColor: "white" },
  automationModes: { gap: 6, padding: 3, borderRadius: 12, backgroundColor: "#EFF0F4" }, automationMode: { minWidth: 76, minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: 9 }, automationModeActive: { backgroundColor: "#1B1E2B" },
  mobileWeekdays: { flexDirection: "row", justifyContent: "space-between", gap: 5 }, mobileWeekday: { flex: 1, height: 36, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#E0E2E9", borderRadius: 10, backgroundColor: "#F9F9FB" },
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
