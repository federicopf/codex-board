import type { BoardThread, ThreadDto } from "../types";
import { buildProjectMap, normalizeProjectPath } from "./projects";
import {
  buildThreadTitle,
  effectiveThreadTitle,
  parseThreadTitle,
} from "./threadStatus";

export interface MoveResult {
  threads: BoardThread[];
  previous: BoardThread;
  updated: BoardThread;
  newName: string;
}

export function toBoardThreads(threads: ThreadDto[]): BoardThread[] {
  const projects = buildProjectMap(threads);
  return threads.map((thread) => {
    const effectiveTitle = effectiveThreadTitle(thread.name, thread.preview);
    const parsed = parseThreadTitle(effectiveTitle);
    const projectKey = normalizeProjectPath(thread.cwd);
    return {
      ...thread,
      ...parsed,
      effectiveTitle,
      projectKey,
      projectLabel: projects.get(projectKey)?.label ?? "Unknown project",
    };
  });
}

export function moveThread(
  threads: BoardThread[],
  threadId: string,
  targetCategory: string,
): MoveResult | null {
  const index = threads.findIndex((thread) => thread.id === threadId);
  if (index < 0 || threads[index].category === targetCategory) return null;

  const previous = threads[index];
  const newName = buildThreadTitle(targetCategory, previous.displayTitle);
  const updated: BoardThread = {
    ...previous,
    name: newName,
    effectiveTitle: newName,
    category: targetCategory,
  };
  const next = [...threads];
  next[index] = updated;
  return { threads: next, previous, updated, newName };
}
