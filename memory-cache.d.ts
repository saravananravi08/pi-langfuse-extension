import type { MemoryScore } from "./memory-state.js";

export interface MemoryCacheSnapshot {
  observations: MemoryScore[];
  reflection?: MemoryScore;
  loadedAt?: number;
}

export interface MemoryCache {
  needsRefresh(key: string): boolean;
  mergeRemote(key: string, observations: MemoryScore[], reflections: MemoryScore[]): void;
  addObservation(key: string, observation: MemoryScore): void;
  setReflection(key: string, reflection: MemoryScore): void;
  get(key: string): MemoryCacheSnapshot;
  invalidate(key?: string): void;
}

export function createMemoryCache(ttlMs?: number, now?: () => number): MemoryCache;
