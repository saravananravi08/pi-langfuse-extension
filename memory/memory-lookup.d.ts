export interface LookupScore {
  id: string;
  name?: string;
  traceId?: string | null;
  sessionId?: string | null;
  createdAt?: string;
  comment?: string | null;
  metadata?: Record<string, unknown>;
}

export interface LookupOptions {
  query?: string;
  scope?: "session" | "path" | "all" | string;
  sessionId?: string;
  pathKey?: string;
  traceId?: string;
  scoreId?: string;
  limit?: number;
}

export function redactSecrets(value: unknown, key?: string): unknown;
export function searchMemoryScores(scores: LookupScore[], options: LookupOptions): Array<{ score: LookupScore; rank: number }>;
export function formatMemoryResult(score: LookupScore): Record<string, unknown>;
