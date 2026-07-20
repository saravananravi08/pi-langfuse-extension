function arrayOfStrings(value) {
  return Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : [];
}

export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return Math.ceil((text || "").length / 4);
}

export function metadataString(score, key) {
  const value = score?.metadata?.[key];
  return typeof value === "string" ? value : "";
}

export function metadataStrings(score, key) {
  return arrayOfStrings(score?.metadata?.[key]);
}

export function generatedAt(score) {
  return metadataString(score, "generatedAt") || score?.createdAt || "";
}

export function sameMemoryScope(score, sessionId, pathKey, version = "v1") {
  return metadataString(score, "version") === version
    && metadataString(score, "sessionId") === sessionId
    && (!pathKey || metadataString(score, "pathKey") === pathKey);
}

export function latestReflection(scores) {
  return [...scores].sort((a, b) => {
    const generationDiff = Number(b.metadata?.generation || 0) - Number(a.metadata?.generation || 0);
    return generationDiff || generatedAt(b).localeCompare(generatedAt(a));
  })[0];
}

export function reflectionFields(score) {
  return score ? {
    reflectionMarkdown: metadataString(score, "reflectionMarkdown"),
    summary: metadataString(score, "summary"),
    goal: metadataStrings(score, "goal"),
    constraints: metadataStrings(score, "constraints"),
    currentTask: metadataString(score, "currentTask"),
    taskStatus: metadataString(score, "taskStatus"),
    completed: metadataStrings(score, "completed"),
    inProgress: metadataStrings(score, "inProgress"),
    openIssues: metadataStrings(score, "openIssues"),
    decisions: metadataStrings(score, "decisions"),
    nextSteps: metadataStrings(score, "nextSteps"),
    criticalContext: metadataStrings(score, "criticalContext"),
    filesRead: metadataStrings(score, "filesRead"),
    filesModified: metadataStrings(score, "filesModified"),
    filesCreated: metadataStrings(score, "filesCreated"),
    filesDeleted: metadataStrings(score, "filesDeleted"),
    filesTouched: metadataStrings(score, "filesTouched"),
    toolsUsed: metadataStrings(score, "toolsUsed"),
  } : null;
}

export function observationFields(score) {
  return {
    scoreId: score.id,
    traceId: score.traceId || metadataString(score, "traceId"),
    generatedAt: generatedAt(score),
    observationsMarkdown: metadataString(score, "observationsMarkdown"),
    summary: metadataString(score, "summary"),
    goal: metadataStrings(score, "goal"),
    constraints: metadataStrings(score, "constraints"),
    currentTask: metadataString(score, "currentTask"),
    taskStatus: metadataString(score, "taskStatus"),
    completed: metadataStrings(score, "completed"),
    inProgress: metadataStrings(score, "inProgress"),
    openIssues: metadataStrings(score, "openIssues"),
    decisions: metadataStrings(score, "decisions"),
    nextSteps: metadataStrings(score, "nextSteps"),
    criticalContext: metadataStrings(score, "criticalContext"),
    filesRead: metadataStrings(score, "filesRead"),
    filesModified: metadataStrings(score, "filesModified"),
    filesCreated: metadataStrings(score, "filesCreated"),
    filesDeleted: metadataStrings(score, "filesDeleted"),
    filesTouched: metadataStrings(score, "filesTouched"),
    toolsUsed: metadataStrings(score, "toolsUsed"),
  };
}

export function buildActiveMemory(observations, reflections, sessionId, pathKey, version = "v1") {
  const scopedObservations = observations
    .filter((score, index, all) => all.findIndex(item => item.id === score.id) === index)
    .filter(score => sameMemoryScope(score, sessionId, pathKey, version))
    .sort((a, b) => generatedAt(a).localeCompare(generatedAt(b)));
  const scopedReflections = reflections
    .filter((score, index, all) => all.findIndex(item => item.id === score.id) === index)
    .filter(score => sameMemoryScope(score, sessionId, pathKey, version));
  const latest = latestReflection(scopedReflections);
  const coveredUntil = metadataString(latest, "coveredUntil");
  const newObservations = coveredUntil
    ? scopedObservations.filter(score => generatedAt(score) > coveredUntil)
    : scopedObservations;
  const previousPayload = JSON.stringify(reflectionFields(latest), null, 2);
  const newObservationPayload = JSON.stringify(newObservations.map(observationFields), null, 2);

  return {
    latestReflection: latest,
    newObservations,
    activeTokens: estimateTokens(`${previousPayload}\n\n${newObservationPayload}`),
    newObservationTokens: newObservations.length ? estimateTokens(newObservationPayload) : 0,
  };
}

export function reflectionThresholdMet(memory, thresholds) {
  return memory.newObservations.length > 0
    && memory.activeTokens >= thresholds.activeTokens
    && memory.newObservationTokens >= thresholds.newObservationTokens
    && memory.newObservations.length >= thresholds.newObservations;
}
