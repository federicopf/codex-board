import { useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { automationOutcome, displayTitle, groupAutomationNotifications } from "@codex-board/protocol";
import type { AutomationNotificationContext, BoardNotification, ProjectCustomer, ThreadDto } from "@codex-board/protocol";
import type { BoardApi } from "./api";
import { MobileIcon } from "./MobileIcon";
import { projectKey } from "./projectOwnership";
import { colors } from "./theme";

type Row = { kind: "group"; key: string; label: string; count: number }
  | { kind: "item"; key: string; notification: BoardNotification; context?: AutomationNotificationContext };

export function InboxModal({ api, items, threads, customers, projectNames, onClose, onOpen, onOpenResult, onChanged, initialTab = "notifications" }: {
  api: BoardApi;
  items: BoardNotification[];
  threads: ThreadDto[];
  customers: ProjectCustomer[];
  projectNames: Record<string, string>;
  onClose: () => void;
  onOpen: (id: string) => void;
  onOpenResult: (item: BoardNotification) => void;
  onChanged: () => void;
  initialTab?: "notifications" | "automations";
}) {
  const [tab, setTab] = useState<"notifications" | "automations">(initialTab);
  const regular = items.filter((item) => !item.automation).sort((a, b) => b.createdAt - a.createdAt);
  const automations = items.filter((item) => Boolean(item.automation));
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const groups = groupAutomationNotifications(automations, (id) => {
    const thread = threadById.get(id);
    if (!thread) return null;
    const key = projectKey(thread.cwd);
    const customer = customers.find((item) => item.threadIds.includes(id));
    const pathLabel = (thread.cwd || "Local project").split(/[\\/]/).filter(Boolean).at(-1) || "Local project";
    return { projectKey: key, projectLabel: projectNames[key] || pathLabel, taskLabel: displayTitle(thread.name, thread.preview), customerName: customer?.name };
  });
  const rows: Row[] = tab === "automations"
    ? groups.flatMap((group) => [{ kind: "group" as const, key: `group:${group.key}`, label: group.label, count: group.items.length }, ...group.items.map(({ notification, context }) => ({ kind: "item" as const, key: notification.id, notification, context }))])
    : regular.map((notification) => ({ kind: "item", key: notification.id, notification }));

  function open(item: BoardNotification) {
    void api.markNotificationsRead(item.id).then(onChanged);
    if (item.automation) onOpenResult(item);
    else if (item.threadId) onOpen(item.threadId);
  }

  return <Modal animationType="slide" onRequestClose={onClose}><SafeAreaView style={styles.page}>
    <View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel="Close inbox" style={styles.headerButton} onPress={onClose}><MobileIcon name="x" size={24} color={colors.text}/></Pressable><View style={styles.headerCopy}><Text style={styles.title}>Inbox</Text><Text style={styles.subtitle}>Notifications and automation results</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Mark all notifications as read" style={styles.headerButton} onPress={() => void api.markNotificationsRead().then(onChanged)}><MobileIcon name="check-circle" size={22} color={colors.primary}/></Pressable></View>
    <View style={styles.tabs}><Pressable style={[styles.tab, tab === "notifications" && styles.tabActive]} onPress={() => setTab("notifications")}><Text style={[styles.tabText, tab === "notifications" && styles.tabTextActive]}>Notifications ({regular.filter((item) => !item.read).length})</Text></Pressable><Pressable style={[styles.tab, tab === "automations" && styles.tabActive]} onPress={() => setTab("automations")}><Text style={[styles.tabText, tab === "automations" && styles.tabTextActive]}>Automations ({automations.filter((item) => !item.read).length})</Text></Pressable></View>
    <FlatList data={rows} keyExtractor={(row) => row.key} contentContainerStyle={styles.list} ListEmptyComponent={<Text style={styles.empty}>{tab === "automations" ? "No automation results yet" : "You're all caught up"}</Text>} renderItem={({ item: row }) => row.kind === "group" ? <View style={styles.groupHeader}><Text style={styles.groupTitle}>{row.label}</Text><Text style={styles.groupCount}>{row.count}</Text></View> : <Pressable style={[styles.card, row.notification.read && styles.read]} onPress={() => open(row.notification)} accessibilityRole="button" accessibilityLabel={row.context ? `${row.notification.automation?.name}, ${row.context.projectLabel}, ${row.context.taskLabel}` : row.notification.title}>
      {row.context ? <><View style={styles.cardTop}><Text style={styles.cardTitle} numberOfLines={2}>{row.notification.automation?.name}</Text><Text style={[styles.outcome, automationOutcome(row.notification.automation?.status).tone === "success" ? styles.success : automationOutcome(row.notification.automation?.status).tone === "failed" ? styles.failed : styles.unknown]}>{automationOutcome(row.notification.automation?.status).label}</Text></View><Text style={styles.task}>{row.context.customerName ? `${row.context.customerName} · ` : ""}{row.context.taskLabel}</Text><Text style={styles.summary} numberOfLines={3}>{row.notification.automation?.result}</Text></> : <><Text style={styles.cardTitle}>{row.notification.title}</Text><Text style={styles.summary} numberOfLines={3}>{row.notification.message}</Text></>}
      <Text style={styles.date}>{new Date(row.notification.createdAt).toLocaleString()}</Text>
    </Pressable>} ListFooterComponent={items.length ? <Pressable style={styles.clear} onPress={() => void api.clearNotifications().then(onChanged)}><Text style={styles.clearText}>Clear all notifications</Text></Pressable> : null}/>
  </SafeAreaView></Modal>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  header: { minHeight: 76, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 10 },
  headerButton: { width: 46, height: 46, alignItems: "center", justifyContent: "center" },
  headerCopy: { flex: 1 }, title: { color: colors.text, fontSize: 23, fontWeight: "800" }, subtitle: { marginTop: 2, color: colors.textMuted, fontSize: 12 },
  tabs: { marginHorizontal: 16, marginBottom: 8, padding: 3, flexDirection: "row", borderRadius: 12, backgroundColor: colors.surfaceMuted },
  tab: { flex: 1, minHeight: 40, alignItems: "center", justifyContent: "center", borderRadius: 9 }, tabActive: { backgroundColor: colors.ink },
  tabText: { color: colors.textMuted, fontSize: 12, fontWeight: "700" }, tabTextActive: { color: "white" },
  list: { paddingHorizontal: 16, paddingBottom: 24 }, empty: { paddingVertical: 50, textAlign: "center", color: colors.textMuted, fontSize: 14 },
  groupHeader: { minHeight: 40, marginTop: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  groupTitle: { color: colors.text, fontSize: 16, fontWeight: "800" }, groupCount: { color: colors.textMuted, fontSize: 12, fontWeight: "700" },
  card: { marginBottom: 9, padding: 15, borderWidth: 1, borderColor: colors.border, borderRadius: 14, backgroundColor: colors.surface },
  read: { backgroundColor: colors.surfaceMuted }, cardTop: { flexDirection: "row", alignItems: "flex-start", gap: 8 }, cardTitle: { flex: 1, color: colors.text, fontSize: 15, fontWeight: "700" },
  outcome: { overflow: "hidden", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 7, fontSize: 11, fontWeight: "700" },
  success: { color: "#177C50", backgroundColor: "#E8F8F0" }, failed: { color: "#B34337", backgroundColor: "#FFF0ED" }, unknown: { color: "#796026", backgroundColor: "#FFF6DD" },
  task: { marginTop: 7, color: colors.primary, fontSize: 13, fontWeight: "700" },
  summary: { marginTop: 7, color: colors.textMuted, fontSize: 13, lineHeight: 19 }, date: { marginTop: 8, color: colors.textSoft, fontSize: 11 },
  clear: { minHeight: 48, alignItems: "center", justifyContent: "center" }, clearText: { color: colors.danger, fontSize: 12, fontWeight: "700" },
});
