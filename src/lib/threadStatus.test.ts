import { describe, expect, it } from "vitest";
import {
  buildThreadTitle,
  effectiveThreadTitle,
  parseThreadTitle,
  threadCategories,
  UNCATEGORIZED,
} from "./threadStatus";

describe("dynamic thread title categories", () => {
  it.each([
    ["To Plan - Ship it", "To Plan", "Ship it"],
    ["WIP - Start", "WIP", "Start"],
    ["Stall, To Monitor - Test form", "Stall, To Monitor", "Test form"],
    ["Something - else - entirely", "Something", "else - entirely"],
    ["No prefix", UNCATEGORIZED, "No prefix"],
    ["", UNCATEGORIZED, ""],
  ])("parses %s from its prefix", (title, category, displayTitle) => {
    expect(parseThreadTitle(title)).toEqual({ category, displayTitle });
  });

  it("builds any category without a fixed allow-list", () => {
    expect(buildThreadTitle("WIP", "Start")).toBe("WIP - Start");
    expect(buildThreadTitle("Custom State", "Title - with dash")).toBe(
      "Custom State - Title - with dash",
    );
    expect(buildThreadTitle(UNCATEGORIZED, "Plain title")).toBe("Plain title");
  });

  it("creates columns from observed prefixes and keeps Uncategorized last", () => {
    expect(threadCategories(["WIP", UNCATEGORIZED, "To Plan", "WIP"])).toEqual([
      "WIP",
      "To Plan",
      UNCATEGORIZED,
    ]);
  });

  it("chooses name, preview, then fallback", () => {
    expect(effectiveThreadTitle(" Named ", "Preview")).toBe("Named");
    expect(effectiveThreadTitle(" ", " Preview ")).toBe("Preview");
    expect(effectiveThreadTitle(null, "")).toBe("Untitled thread");
  });
});
