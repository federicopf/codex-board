import type { Automation, AutomationIntervalUnit, CreateAutomationInput } from "./index";

/** Local wall-clock value accepted by both datetime-local and the mobile date input. */
export function automationDateTimeValue(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function automationEditFields(automation: Automation) {
  const action = automation.action;
  const pipeline = action.kind === "categoryPipeline" || action.kind === "scheduledCategoryPipeline";
  const interval = action.kind === "recurringMessage" ? action.everyMinutes : 60;
  const intervalUnit: AutomationIntervalUnit = interval % 1440 === 0 ? "days" : interval % 60 === 0 ? "hours" : "minutes";
  return {
    name: automation.name,
    pipeline,
    kind: pipeline ? "recurringMessage" as const : action.kind,
    threadId: "threadId" in action ? action.threadId : "",
    prompt: "prompt" in action ? action.prompt : "",
    intervalValue: String(interval / (intervalUnit === "days" ? 1440 : intervalUnit === "hours" ? 60 : 1)),
    intervalUnit,
    minutes: String(action.kind === "categoryPipeline" ? action.afterMinutes : 60),
    runAt: "runAt" in action ? automationDateTimeValue(action.runAt) : "",
    time: action.kind === "calendarMessage" ? `${String(Math.floor(action.minuteOfDay / 60)).padStart(2, "0")}:${String(action.minuteOfDay % 60).padStart(2, "0")}` : "09:00",
    weekdays: action.kind === "calendarMessage" ? [...action.weekdays] : [1, 2, 3, 4, 5],
    fromCategory: pipeline ? action.fromCategory : "",
    toCategory: pipeline ? action.toCategory : "",
    pipelineTiming: action.kind === "scheduledCategoryPipeline" ? "scheduled" as const : "delay" as const,
  };
}

/** Keep timestamp precision and the stored calendar timezone when editing from another device. */
export function automationUpdateInput(input: CreateAutomationInput, original: Automation): CreateAutomationInput {
  const action = input.action;
  const old = original.action;
  if ("runAt" in action && "runAt" in old && action.kind === old.kind &&
      action.runAt === new Date(automationDateTimeValue(old.runAt)).getTime()) {
    return { ...input, action: { ...action, runAt: old.runAt } } as CreateAutomationInput;
  }
  if (action.kind === "calendarMessage" && old.kind === "calendarMessage") {
    return { ...input, action: { ...action, timezoneOffsetMinutes: old.timezoneOffsetMinutes } };
  }
  return input;
}
