export interface ContextMemoryPayload {
  reflection?: Record<string, unknown>;
  observations: Array<Record<string, unknown>>;
}

export const MEMORY_CUSTOM_TYPE: "langfuse-memory-context";
export function buildMemoryContextText(memory: ContextMemoryPayload, maxChars?: number): string;
export function replaceWithMemoryContext<T>(messages: T[], memoryText: string, recentTurns?: number, timestamp?: number): Array<T | {
  role: "custom";
  customType: "langfuse-memory-context";
  content: string;
  display: false;
  timestamp: number;
}>;
