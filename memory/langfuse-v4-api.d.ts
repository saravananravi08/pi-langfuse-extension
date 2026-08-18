export function parseObservationIo(value: unknown): unknown;
export function normalizeObservationV2<T extends Record<string, unknown>>(observation: T): T & { input?: unknown; output?: unknown };
export function traceFromRootObservation(observation: Record<string, unknown>): Record<string, unknown> & { id?: string; timestamp?: string; name?: string };
export function normalizeScoreV3<T extends Record<string, unknown>>(score: T): T & { traceId?: string | null; observationId?: string | null; sessionId?: string | null };
export function sessionObservationBounds(sessionId: string, now?: number): { fromStartTime: string; toStartTime: string };
