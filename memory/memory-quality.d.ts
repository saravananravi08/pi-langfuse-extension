export interface RecentUserRequest {
  entryId: string;
  text: string;
  timestamp: string | null;
  correction: boolean;
}
export interface DurableItem {
  id: string;
  kind: "request" | "decision" | "constraint" | "fact" | "task" | "question" | "commitment";
  topic: string;
  content: string;
  status: "active" | "completed" | "superseded" | "revoked" | "proposed";
  authority: "user" | "verified-result" | "assistant-proposal";
  sourceEntryIds: string[];
  sourceScoreIds: string[];
  updatedAt: string;
}
export function textSupportsClaim(sourceText: unknown, claimText: unknown, minimumRatio?: number): boolean;
export function detectExplicitCorrection(text: unknown): boolean;
export function buildRecentUserRequests(branchEntries: Array<Record<string, any>>, options?: { maxMessages?: number; maxTokens?: number }): RecentUserRequest[];
export function classifyMemoryQuery(prompt: unknown): "referential" | "decision" | "progress" | "code" | "continuation" | "general";
export function rankRelevantObservations<T>(observations: T[], prompt: unknown, limit?: number): T[];
export function normalizeDurableItem(value: unknown, defaults?: Partial<DurableItem>): DurableItem | null;
export function sanitizeDurableItemSources(item: DurableItem | null, provenance?: Record<string, unknown>): DurableItem | null;
export function validateDurableItemAuthority(item: DurableItem, provenance?: Record<string, unknown>): boolean;
export function alignDurableItems(previousItems: unknown[], newItems: unknown[], reflectorItems: unknown[]): unknown[];
export function reduceDurableItems(previousItems: unknown[], candidateItems: unknown[]): {
  items: DurableItem[];
  active: DurableItem[];
  proposed: DurableItem[];
  completed: DurableItem[];
  superseded: DurableItem[];
  conflicts: Array<{ topic: string; winner: DurableItem; rejected: DurableItem; reason: string }>;
};
export function buildSemanticCoverage(value?: Record<string, any>): { replacementEligible: boolean; semanticCoverage: Record<string, number> };
export function semanticCoverageComplete(metadata: Record<string, any> | undefined): boolean;
export function prepareMetadataReplacement<T>(value: T, previous: unknown): T;
export function explainDurableItems(items: DurableItem[], query: unknown): DurableItem[];
