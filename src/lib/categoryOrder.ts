export const CATEGORY_ORDER_STORAGE_KEY = "codex-board.category-order.v1";

export function reconcileCategoryOrder(current: string[], discovered: string[]): string[] {
  const available = new Set(discovered);
  const retained = current.filter((category) => available.has(category));
  const retainedSet = new Set(retained);
  return [...retained, ...discovered.filter((category) => !retainedSet.has(category))];
}

export function orderVisibleCategories(discovered: string[], preferred: string[]): string[] {
  const available = new Set(discovered);
  const ordered = preferred.filter((category) => available.has(category));
  const orderedSet = new Set(ordered);
  return [...ordered, ...discovered.filter((category) => !orderedSet.has(category))];
}

export function moveCategory(order: string[], active: string, over: string): string[] {
  const from = order.indexOf(active);
  const to = order.indexOf(over);
  if (from < 0 || to < 0 || from === to) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, active);
  return next;
}

export function loadCategoryOrder(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(CATEGORY_ORDER_STORAGE_KEY) || "[]");
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
  } catch {
    return [];
  }
}

export function saveCategoryOrder(order: string[]): void {
  localStorage.setItem(CATEGORY_ORDER_STORAGE_KEY, JSON.stringify(order));
}
