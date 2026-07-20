export interface PiToolPair {
  toolCallId: string;
  toolName: string | null;
  assistantEntryId: string;
  toolResultEntryId: string | null;
}

export interface PiTraceProvenance {
  version: "pi-entry-v1";
  piSessionId: string | null;
  firstEntryId: string | null;
  lastEntryId: string | null;
  startEntryParentId: string | null;
  branchLeafEntryId: string | null;
  entryIds: string[];
  messageEntryIds: string[];
  userEntryId: string | null;
  userEntryIds: string[];
  assistantEntryIds: string[];
  toolResultEntryIds: string[];
  toolPairs: PiToolPair[];
  missingToolResultIds: string[];
  orphanToolResultIds: string[];
  unexecutedToolCallIds: string[];
  complete: boolean;
}

export function aggregatePiReflectionProvenance(
  previousMetadata: Record<string, unknown> | undefined,
  observations: Array<{ id: string; traceId?: string | null; metadata?: Record<string, unknown> }>,
): Record<string, unknown>;

export function findPiTraceStartEntryId(entries: Array<Record<string, unknown>>, parentEntryId: string): string;
export function buildPiTraceProvenance(
  entries: Array<Record<string, unknown>>,
  startEntryId: string,
  piSessionId: string,
): { provenance?: PiTraceProvenance; errors: string[] };
