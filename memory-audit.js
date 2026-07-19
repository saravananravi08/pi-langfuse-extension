export function auditObservationCoverage(traces, scores, options) {
  const byTrace = new Map();
  for (const score of scores) {
    if (score.name !== options.scoreName || score.metadata?.version !== options.version) continue;
    const traceId = score.traceId || score.metadata?.traceId;
    if (!traceId) continue;
    const list = byTrace.get(traceId) || [];
    list.push(score);
    byTrace.set(traceId, list);
  }

  const observedTimestamps = traces
    .filter(trace => (byTrace.get(trace.id) || []).length > 0)
    .map(trace => Date.parse(trace.timestamp || ""))
    .filter(Number.isFinite);
  const coverageStartTimestamp = observedTimestamps.length ? Math.min(...observedTimestamps) : undefined;

  const eligibleMissingTraceIds = [];
  const preCoverageTraceIds = [];
  const intentionallySkippedTraceIds = [];
  const duplicateTraceIds = [];
  const nonDeterministicScoreIds = [];
  const promptVersions = {};
  const paths = {};
  let observedTraces = 0;

  for (const trace of traces) {
    const pathKey = trace.metadata?.cwd || "(unknown)";
    const path = paths[pathKey] || { traces: 0, observed: 0, eligibleMissing: 0, preCoverage: 0, intentionallySkipped: 0 };
    path.traces++;
    paths[pathKey] = path;

    const traceScores = byTrace.get(trace.id) || [];
    if (traceScores.length) {
      observedTraces++;
      path.observed++;
      if (traceScores.length > 1) duplicateTraceIds.push(trace.id);
      for (const score of traceScores) {
        const promptVersion = score.metadata?.promptVersion || "unknown";
        promptVersions[promptVersion] = (promptVersions[promptVersion] || 0) + 1;
        const expectedId = options.expectedScoreId(trace.id);
        if (score.id !== expectedId) nonDeterministicScoreIds.push(score.id);
      }
      continue;
    }

    const intentionallySkipped = trace.name !== "pi-agent" || trace.metadata?.completed !== true;
    const traceTimestamp = Date.parse(trace.timestamp || "");
    const predatesCoverage = coverageStartTimestamp !== undefined && Number.isFinite(traceTimestamp) && traceTimestamp < coverageStartTimestamp;
    if (intentionallySkipped) {
      intentionallySkippedTraceIds.push(trace.id);
      path.intentionallySkipped++;
    } else if (predatesCoverage) {
      preCoverageTraceIds.push(trace.id);
      path.preCoverage++;
    } else {
      eligibleMissingTraceIds.push(trace.id);
      path.eligibleMissing++;
    }
  }

  return {
    traces: traces.length,
    observedTraces,
    observationScores: scores.filter(score => score.name === options.scoreName && score.metadata?.version === options.version).length,
    eligibleMissing: eligibleMissingTraceIds.length,
    preCoverage: preCoverageTraceIds.length,
    intentionallySkipped: intentionallySkippedTraceIds.length,
    duplicateTraces: duplicateTraceIds.length,
    nonDeterministicScores: nonDeterministicScoreIds.length,
    promptVersions,
    paths,
    coverageStart: coverageStartTimestamp === undefined ? null : new Date(coverageStartTimestamp).toISOString(),
    eligibleMissingTraceIds,
    preCoverageTraceIds,
    intentionallySkippedTraceIds,
    duplicateTraceIds,
    nonDeterministicScoreIds,
  };
}
