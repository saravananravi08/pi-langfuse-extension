export interface ContextMemoryPayload {
  reflection?: Record<string, unknown>;
  legacyReflection?: Record<string, unknown>;
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
  semanticCoverageFailures: string[];
  replacementEligibleScoreIds: string[];
  lookupOnlyScoreIds: string[];
  compatibilityScoreIds: string[];
  coveredThroughEntryId: string | null;
}

export interface TemporalMemoryTurn {
  userEntryId: string;
  textEntryIds: string[];
  lastTextEntryId: string;
  observationScoreId: string | null;
  branchIndex: number;
  generatedAt: string;
  observation: Record<string, unknown> | null;
}

export interface MemoryContextPlan {
  safe: boolean;
  reasons: string[];
  messages: unknown[];
  scoreIds: string[];
  coveredThroughEntryId: string | null;
  droppedEntryIds: string[];
  retainedEntryIds: string[];
  recentRetainedEntryIds: string[];
  textRetainedEntryIds: string[];
  temporalTurnCount: number;
  compactedToolCallIds: string[];
  semanticCoverageFailures: string[];
  replacementEligibleScoreIds: string[];
  lookupOnlyScoreIds: string[];
  compatibilityScoreIds: string[];
  unmappedMessageIndexes: number[];
  retainedUnmappedTailIndexes: number[];
  toolPairs: Array<Record<string, unknown>>;
  originalTokensEstimated: number;
  memoryTokensEstimated: number;
  originalMemoryTokensEstimated: number;
  memoryTruncated: boolean;
  retainedTokensEstimated: number;
  replacementTokensEstimated: number;
  originalImageCount: number;
  memoryImageCount: number;
  retainedImageCount: number;
  replacementImageCount: number;
}

export const MEMORY_CUSTOM_TYPE: "langfuse-memory-context";
export function filterMemoryScoresForBranch<T extends MemoryContextScore>(scores: T[], branchEntries: Array<string | Record<string, unknown>>): T[];
export function buildTemporalTurnTimeline(branchEntries: Array<Record<string, unknown>>, observations: MemoryContextScore[], options?: { maxTurns?: number }): TemporalMemoryTurn[];
export function buildMemoryContextText(memory: ContextMemoryPayload & { currentPrompt?: string; recentUserRequests?: unknown[] }, options?: number | { maxChars?: number; currentPrompt?: string; recentUserRequests?: unknown[] }): string;
export function buildMemoryContextCoverage(
  reflection: MemoryContextScore | undefined,
  observations: MemoryContextScore[],
  expectedPiSessionId?: string,
  legacyReflection?: MemoryContextScore,
  legacyObservations?: MemoryContextScore[],
): MemoryContextCoverage;
export function planMemoryContextReplacement(
  messages: unknown[],
  branchEntries: Array<Record<string, unknown>>,
  memoryText: string,
  coverage: MemoryContextCoverage,
  timestamp?: number,
  options?: { recentTurnCount?: number; recentRawTokenBudget?: number; maxReplacementTokens?: number; temporalTurns?: TemporalMemoryTurn[] },
): MemoryContextPlan;
export function formatMemoryContextPreview(plan: MemoryContextPlan, maxIds?: number): string;
export function formatMemoryContextStatus(status: {
  actualInputTokens?: number;
  contextWindow?: number;
  replacementTokensEstimated?: number;
  replacementImageCount?: number;
  modelCost?: number;
  modelCostSubscription?: boolean;
}): string;
