export function isAbortError(error: unknown): boolean;
export function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<void>;
