import type { ProjectCustomer } from "@codex-board/protocol";

// Match the desktop board's project identity across Windows path separators.
export function projectKey(cwd: string | null | undefined): string {
  if (!cwd?.trim()) return "__local__";
  let normalized = cwd.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  if (/^[a-zA-Z]:$/.test(normalized)) normalized += "/";
  if (/^[a-zA-Z]:\//.test(normalized)) normalized = normalized.toLowerCase();
  return normalized || "/";
}

export function filterCustomerBoardThreads<T extends { id: string }>(threads: T[], customers: ProjectCustomer[], customerId: string | null): T[] {
  const selectedCustomer = customers.find((customer) => customer.id === customerId);
  return selectedCustomer
    ? threads.filter((thread) => selectedCustomer.threadIds.includes(thread.id))
    : threads.filter((thread) => !customers.some((customer) => customer.threadIds.includes(thread.id)));
}
