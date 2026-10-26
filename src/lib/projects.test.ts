import { describe, expect, it } from "vitest";
import type { ThreadDto } from "../types";
import { ALL_PROJECTS, buildProjectMap, normalizeProjectPath, sameProjectPath } from "./projects";
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
    expect(sameProjectPath("C:\\Code\\Demo", "c:/code/demo/")).toBe(true);
  });

  it("preserves case for WSL and other case-sensitive paths when matching project drops", () => {
    expect(sameProjectPath("/mnt/c/Users/Asus/project", "/mnt/c/Users/Asus/project/")).toBe(true);
    expect(sameProjectPath("/mnt/c/Users/Asus/project", "/mnt/c/users/asus/project")).toBe(false);
    expect(sameProjectPath(null, null)).toBe(false);
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

  it("keeps registered projects even when they have no threads", () => {
    const map = buildProjectMap([], ["C:\\work\\empty"]);
    expect(map.get("c:/work/empty")).toEqual({ key: "c:/work/empty", label: "empty", cwd: "C:\\work\\empty" });
  });
});
