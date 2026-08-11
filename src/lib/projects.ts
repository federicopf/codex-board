import type { ThreadDto } from "../types";

export const ALL_PROJECTS = "__all_projects__";
export const UNKNOWN_PROJECT = "__unknown_project__";

export interface ProjectInfo {
  key: string;
  label: string;
}

export function normalizeProjectPath(cwd: string | null | undefined): string {
  if (!cwd?.trim()) return UNKNOWN_PROJECT;

  let normalized = cwd.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  if (/^[a-zA-Z]:$/.test(normalized)) normalized += "/";
  if (/^[a-zA-Z]:\//.test(normalized)) normalized = normalized.toLowerCase();
  return normalized || "/";
}

function segments(key: string): string[] {
  return key.split("/").filter(Boolean);
}

export function buildProjectMap(threads: ThreadDto[]): Map<string, ProjectInfo> {
  const keys = [...new Set(threads.map((thread) => normalizeProjectPath(thread.cwd)))];
  const baseCounts = new Map<string, number>();

  for (const key of keys) {
    if (key === UNKNOWN_PROJECT) continue;
    const parts = segments(key);
    const base = parts.at(-1) ?? key;
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }

  return new Map(
    keys.map((key) => {
      if (key === UNKNOWN_PROJECT) {
        return [key, { key, label: "Unknown project" }];
      }
      const parts = segments(key);
      const base = parts.at(-1) ?? key;
      const parent = parts.at(-2);
      const duplicate = (baseCounts.get(base) ?? 0) > 1;
      const label = duplicate && parent ? `${parent} / ${base}` : base;
      return [key, { key, label }];
    }),
  );
}

export function projectOptions(projectMap: Map<string, ProjectInfo>): ProjectInfo[] {
  return [...projectMap.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
}
