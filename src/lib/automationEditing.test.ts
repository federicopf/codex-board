import { afterEach, describe, expect, it, vi } from "vitest";
import { automationDateTimeValue, automationEditFields, automationUpdateInput, type Automation, type AutomationAction } from "@codex-board/protocol";
import { BoardApi } from "../../apps/mobile/src/api";

vi.mock("../../apps/mobile/src/connection", () => ({ loadLegacyTurnSettings: vi.fn(), saveLegacyTurnSettings: vi.fn() }));
const automation = (action: AutomationAction): Automation => ({ id: "a/1", name: "Review", enabled: false, action, lastRunAt: 10, lastError: null });
afterEach(() => vi.unstubAllGlobals());

describe("editing shared automation forms", () => {
  it.each([[1440, "1", "days"], [120, "2", "hours"], [75, "75", "minutes"]] as const)("prefills %i minutes without rounding", (minutes, value, unit) => {
    const fields = automationEditFields(automation({ kind: "recurringMessage", threadId: "t", prompt: "Check", everyMinutes: minutes, nextRunAt: 10 }));
    expect(fields).toMatchObject({ threadId: "t", prompt: "Check", intervalValue: value, intervalUnit: unit });
  });

  it("keeps original timestamp precision when the visible date is unchanged", () => {
    const original = automation({ kind: "scheduledMessage", threadId: "t", prompt: "Check", runAt: 1800000004321 });
    const fields = automationEditFields(original);
    const input = automationUpdateInput({ name: "Renamed", action: { kind: "scheduledMessage", threadId: "t", prompt: "Edited", runAt: new Date(fields.runAt).getTime() } }, original);
    expect(input.action).toMatchObject({ runAt: 1800000004321 });
    expect(automationDateTimeValue(1800000004321)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("preserves the saved calendar timezone on a different device", () => {
    const original = automation({ kind: "calendarMessage", threadId: "t", prompt: "Check", weekdays: [1, 5], minuteOfDay: 570, timezoneOffsetMinutes: -330, nextRunAt: 42 });
    expect(automationEditFields(original)).toMatchObject({ time: "09:30", weekdays: [1, 5] });
    expect(automationUpdateInput({ name: "Edited", action: { kind: "calendarMessage", threadId: "t", prompt: "New", weekdays: [2], minuteOfDay: 600, timezoneOffsetMinutes: 0 } }, original).action).toMatchObject({ timezoneOffsetMinutes: -330, minuteOfDay: 600, weekdays: [2] });
  });

  it.each(["categoryPipeline", "scheduledCategoryPipeline"] as const)("prefills %s with custom categories", kind => {
    const action: AutomationAction = kind === "categoryPipeline" ? { kind, fromCategory: "Custom", toCategory: "Ship", afterMinutes: 75 } : { kind, fromCategory: "Custom", toCategory: "Ship", runAt: 1800000000000 };
    expect(automationEditFields(automation(action))).toMatchObject({ pipeline: true, fromCategory: "Custom", toCategory: "Ship", pipelineTiming: kind === "categoryPipeline" ? "delay" : "scheduled" });
  });

  it("PATCHes the existing automation with authentication, never recreating it", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "a/1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const input = { name: "Edited", action: { kind: "categoryPipeline" as const, fromCategory: "Review", toCategory: "Ship", afterMinutes: 60 } };
    await new BoardApi({ baseUrl: "http://fixture", token: "fixture" }).updateAutomation("a/1", input);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("http://fixture/v1/automations/a%2F1", expect.objectContaining({ method: "PATCH", body: JSON.stringify(input), headers: expect.objectContaining({ Authorization: "Bearer fixture" }) }));
  });

  it("explains that old desktop gateways need upgrading and preserves server validation errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 405 })));
    const api = new BoardApi({ baseUrl: "http://fixture", token: "fixture" });
    const input = { name: "Edited", action: { kind: "categoryPipeline" as const, fromCategory: "Review", toCategory: "Ship", afterMinutes: 60 } };
    await expect(api.updateAutomation("a", input)).rejects.toThrow("Update Codex Board on your PC");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Invalid delay" }), { status: 400 })));
    await expect(api.updateAutomation("a", input)).rejects.toThrow("Invalid delay");
  });
});
