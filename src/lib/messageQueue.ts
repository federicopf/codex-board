import type { QueuedMessage } from "../types";

export type MessageQueues = Record<string, QueuedMessage[]>;

export function enqueueMessage(queues: MessageQueues, threadId: string, message: QueuedMessage): MessageQueues {
  return { ...queues, [threadId]: [...(queues[threadId] || []), message] };
}

export function takeNextMessage(queues: MessageQueues, threadId: string): { queues: MessageQueues; message: QueuedMessage | null } {
  const current = queues[threadId] || [];
  if (current.length === 0) return { queues, message: null };
  const next = { ...queues };
  if (current.length === 1) delete next[threadId];
  else next[threadId] = current.slice(1);
  return { queues: next, message: current[0] };
}

export function removeQueuedMessage(queues: MessageQueues, threadId: string, messageId: string): MessageQueues {
  const remaining = (queues[threadId] || []).filter((message) => message.id !== messageId);
  const next = { ...queues };
  if (remaining.length === 0) delete next[threadId];
  else next[threadId] = remaining;
  return next;
}
