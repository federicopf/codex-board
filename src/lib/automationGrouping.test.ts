import { describe, expect, it } from "vitest";
import { groupAutomationsByOwner, type Automation } from "@codex-board/protocol";

const task = (id: string, threadId: string): Automation => ({ id, name: id, enabled: true, lastRunAt: null, lastError: null, action: { kind: "recurringMessage", threadId, prompt: "Check", everyMinutes: 60, nextRunAt: 1 } });

describe("automation ownership groups", () => {
  it("separates project threads and customers without moving the automation", () => {
    const items = [task("customer", "t2"), task("generic", "t1"), task("other", "t3")];
    const owners = {
      t1: { projectKey: "amati", projectLabel: "Amati" },
      t2: { projectKey: "amati", projectLabel: "Amati", customerId: "content", customerName: "Amati Content" },
      t3: { projectKey: "other", projectLabel: "Other" },
    };
    const groups = groupAutomationsByOwner(items, (id) => owners[id as keyof typeof owners] || null);
    expect(groups.map((group) => [group.label, group.automations.map((item) => item.id)])).toEqual([
      ["Amati", ["generic"]],
      ["Amati › Amati Content", ["customer"]],
      ["Other", ["other"]],
    ]);
  });
});
