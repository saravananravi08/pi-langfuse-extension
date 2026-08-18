export function parseObservationIo(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function normalizeObservationV2(observation) {
  return {
    ...observation,
    input: parseObservationIo(observation?.input),
    output: parseObservationIo(observation?.output),
  };
}

export function traceFromRootObservation(observation) {
  const root = normalizeObservationV2(observation);
  return {
    id: root.traceId,
    timestamp: root.startTime,
    name: root.traceName || root.name,
    input: root.input,
    output: root.output,
    sessionId: root.sessionId,
    metadata: root.metadata || {},
    environment: root.environment,
    release: root.release,
    tags: root.tags || [],
  };
}

export function normalizeScoreV3(score) {
  const subject = score?.subject && typeof score.subject === "object" ? score.subject : {};
  return {
    ...score,
    traceId: subject.kind === "trace" ? subject.id : subject.traceId || score?.metadata?.traceId || null,
    observationId: subject.kind === "observation" ? subject.id : null,
    sessionId: subject.kind === "session" ? subject.id : score?.metadata?.sessionId || null,
  };
}

export function sessionObservationBounds(sessionId, now = Date.now()) {
  const match = String(sessionId || "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  const timestamp = match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`) : NaN;
  const start = Number.isFinite(timestamp) ? timestamp - 86_400_000 : now - 365 * 86_400_000;
  return {
    fromStartTime: new Date(start).toISOString(),
    toStartTime: new Date(now + 86_400_000).toISOString(),
  };
}
