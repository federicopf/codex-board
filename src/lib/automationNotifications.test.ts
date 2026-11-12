import { expect, it } from "vitest";
import { groupAutomationNotifications, type BoardNotification } from "@codex-board/protocol";

const result = (id: string, threadId: string | null, createdAt: number): BoardNotification => ({
  id, threadId, createdAt, kind: "automation", read: false, title: "Automation succeeded", message: "Done",
  automation: { id, name: `Check ${id}`, status: "success", result: "Done", durationMs: null },
});

it("groups results by project and keeps the newest task results first", () => {
  const groups = groupAutomationNotifications([
    result("old", "amati-1", 1), result("other", "other-1", 2), result("new", "amati-2", 3),
  ], (id) => id.startsWith("amati")
    ? { projectKey: "amati", projectLabel: "Amati", taskLabel: id === "amati-1" ? "Audit" : "Content", customerName: "Content client" }
    : { projectKey: "other", projectLabel: "Other", taskLabel: "Deployment" });
  expect(groups.map((group) => group.label)).toEqual(["Amati", "Other"]);
  expect(groups[0].items.map((item) => item.notification.id)).toEqual(["new", "old"]);
  expect(groups[0].items[0].context).toMatchObject({ taskLabel: "Content", customerName: "Content client" });
});

it("labels board-wide and unavailable conversations without losing their results", () => {
  const groups = groupAutomationNotifications([result("pipeline", null, 2), result("missing", "gone", 1)], () => null);
  expect(groups.map((group) => group.label)).toEqual(["Board-wide", "Unavailable project"]);
  expect(groups[1].items[0].context.taskLabel).toBe("Conversation unavailable");
});
