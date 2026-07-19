export interface MemoryScore {
  id: string;
  traceId?: string | null;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ActiveMemory {
  latestReflection?: MemoryScore;
  newObservations: MemoryScore[];
  activeTokens: number;
  newObservationTokens: number;
}

export function estimateTokens(value: unknown): number;
export function metadataString(score: MemoryScore | undefined, key: string): string;
export function metadataStrings(score: MemoryScore | undefined, key: string): string[];
export function generatedAt(score: MemoryScore): string;
export function sameMemoryScope(score: MemoryScore, sessionId: string, pathKey: string, version?: string): boolean;
export function latestReflection(scores: MemoryScore[]): MemoryScore | undefined;
export function reflectionFields(score: MemoryScore | undefined): Record<string, unknown> | null;
export function observationFields(score: MemoryScore): Record<string, unknown> & {
  filesRead: string[];
  filesModified: string[];
  filesCreated: string[];
  filesDeleted: string[];
  filesTouched: string[];
  toolsUsed: string[];
};
export function buildActiveMemory(observations: MemoryScore[], reflections: MemoryScore[], sessionId: string, pathKey: string, version?: string): ActiveMemory;
export function reflectionThresholdMet(memory: ActiveMemory, thresholds: {
  activeTokens: number;
  newObservationTokens: number;
  newObservations: number;
}): boolean;
