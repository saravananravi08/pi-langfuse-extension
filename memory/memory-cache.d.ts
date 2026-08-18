import type { MemoryScore } from "./memory-state.js";

export interface MemoryCacheSnapshot {
  observations: MemoryScore[];
  reflection?: MemoryScore;
  loadedAt?: number;
}

export interface FullMemoryCacheSnapshot extends MemoryCacheSnapshot {
  reflections: MemoryScore[];
}

export interface MemoryCache {
  needsRefresh(key: string): boolean;
  mergeRemote(key: string, observations: MemoryScore[], reflections: MemoryScore[]): void;
  addObservation(key: string, observation: MemoryScore): void;
  setReflection(key: string, reflection: MemoryScore): void;
  get(key: string): MemoryCacheSnapshot;
  getAll(key: string): FullMemoryCacheSnapshot;
  invalidate(key?: string): void;
}

export function createMemoryCache(ttlMs?: number, now?: () => number): MemoryCache;
