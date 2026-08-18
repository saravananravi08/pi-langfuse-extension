export function findPiSessionFile(sessionsRoot: string, sessionId: string, piSessionId?: string, currentSessionFile?: string): string;
export function provenanceEntryIds(scores: Array<{ metadata?: Record<string, unknown> }>, maxEntries?: number): string[];
export function readBoundedPiEntries(sessionFile: string, requestedEntryIds: string[], maxEntries?: number, maxCharsPerEntry?: number): {
  entries: Array<Record<string, unknown>>;
  requestedEntryCount: number;
  returnedEntryCount: number;
  missingEntryIds: string[];
  truncated: boolean;
};
