import { describe, expect, it } from "vitest";
import type { ThreadDto } from "../types";
import { ALL_PROJECTS, buildProjectMap, normalizeProjectPath } from "./projects";
import { toBoardThreads } from "./board";

const thread = (id: string, cwd: string | null): ThreadDto => ({
  id,
  cwd,
  name: id,
  preview: null,
  updatedAt: null,
});

describe("projects", () => {
  it("normalizes Windows paths case-insensitively", () => {
    expect(normalizeProjectPath("C:\\Code\\Demo\\")).toBe("c:/code/demo");
  });

  it("disambiguates duplicate basenames with their parent", () => {
    const map = buildProjectMap([
      thread("a", "C:\\work\\client-a\\web"),
      thread("b", "D:\\work\\client-b\\web"),
      thread("c", null),
    ]);
    expect(map.get("c:/work/client-a/web")?.label).toBe("client-a / web");
    expect(map.get("d:/work/client-b/web")?.label).toBe("client-b / web");
    expect([...map.values()].some(({ label }) => label === "Unknown project")).toBe(true);
  });

  it("supports the All projects filter", () => {
    const board = toBoardThreads([thread("a", "C:\\one"), thread("b", "C:\\two")]);
    const selected = ALL_PROJECTS;
    expect(selected === ALL_PROJECTS ? board : board.filter((item) => item.projectKey === selected)).toHaveLength(2);
  });
});
