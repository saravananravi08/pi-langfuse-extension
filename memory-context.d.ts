export interface ContextMemoryPayload {
  reflection?: Record<string, unknown>;
  observations: Array<Record<string, unknown>>;
}

export interface MemoryContextScore {
  id: string;
  traceId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface MemoryContextCoverage {
  safe: boolean;
  reasons: string[];
  scoreIds: string[];
  piSessionIds: string[];
  entryIds: string[];
  ranges: Array<Record<string, unknown>>;
  toolPairs: Array<Record<string, unknown>>;
  unexecutedToolCallIds: string[];
  overlappingEntryIds: string[];
  coveredThroughEntryId: string | null;
}

export interface MemoryContextPlan {
  safe: boolean;
  reasons: string[];
  messages: unknown[];
  scoreIds: string[];
  coveredThroughEntryId: string | null;
  droppedEntryIds: string[];
  retainedEntryIds: string[];
  unmappedMessageIndexes: number[];
  retainedUnmappedTailIndexes: number[];
  toolPairs: Array<Record<string, unknown>>;
  originalTokensEstimated: number;
  memoryTokensEstimated: number;
  retainedTokensEstimated: number;
  replacementTokensEstimated: number;
}

export const MEMORY_CUSTOM_TYPE: "langfuse-memory-context";
export function buildMemoryContextText(memory: ContextMemoryPayload, maxChars?: number): string;
export function buildMemoryContextCoverage(
  reflection: MemoryContextScore | undefined,
  observations: MemoryContextScore[],
  expectedPiSessionId?: string,
): MemoryContextCoverage;
export function planMemoryContextReplacement(
  messages: unknown[],
  branchEntries: Array<Record<string, unknown>>,
  memoryText: string,
  coverage: MemoryContextCoverage,
  timestamp?: number,
): MemoryContextPlan;
export function formatMemoryContextPreview(plan: MemoryContextPlan, maxIds?: number): string;
export function formatMemoryContextStatus(status: {
  actualInputTokens?: number;
  contextWindow?: number;
  replacementTokensEstimated?: number;
}): string;
