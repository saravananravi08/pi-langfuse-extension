import type { MemoryScore } from "./memory-state.js";

export interface MemoryDiskCacheScope {
  sessionId: string;
  piSessionId?: string;
  pathKey: string;
  branchLeafEntryId?: string;
}

export interface MemoryDiskCacheSnapshot {
  scores: MemoryScore[];
  savedAt: string;
  branchLeafEntryId: string;
}

export interface MemoryDiskCache {
  filePath(sessionId: string, pathKey: string): string;
  load(scope: MemoryDiskCacheScope): Promise<MemoryDiskCacheSnapshot | undefined>;
  save(scope: MemoryDiskCacheScope, scores: MemoryScore[]): Promise<boolean>;
  merge(scope: MemoryDiskCacheScope, scores: MemoryScore[]): Promise<boolean>;
}

export function createMemoryDiskCache(options: { rootDir: string; host: string; projectKey: string }): MemoryDiskCache;
