const SEMANTIC_FIELDS = [
  "summary",
  "goal",
  "constraints",
  "currentTask",
  "taskStatus",
  "completed",
  "inProgress",
  "openIssues",
  "decisions",
  "nextSteps",
  "criticalContext",
  "filesRead",
  "filesModified",
  "filesCreated",
  "filesDeleted",
  "filesTouched",
  "toolsUsed",
  "episodeSummary",
  "userRequests",
  "questionsAnswered",
  "corrections",
  "taskDelta",
  "commitments",
  "durableItems",
  "activeUserRequests",
  "activeDecisions",
  "activeConstraints",
  "verifiedFacts",
  "openQuestions",
  "supersededItems",
  "piUserEntryId",
  "piFirstEntryId",
  "piLastEntryId",
  "piEntryIds",
  "piMessageEntryIds",
  "piToolPairs",
  "piUnexecutedToolCallIds",
  "sourcePiEntryIds",
  "sourcePiRanges",
  "sourcePiToolPairs",
  "coveredThroughPiEntryId",
  "observationsMarkdown",
  "reflectionMarkdown",
];

const SECRET_KEY = /^(?:api.?key|authorization|cookie|credentials?|password|secret(?:key)?|token|access.?token|refresh.?token|auth.?token)$/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk|pk|npm)_[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

function metadataString(score, key) {
  const value = score?.metadata?.[key];
  return typeof value === "string" ? value : "";
}

function clamp(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
}

function strings(value, limit = 20) {
  return Array.isArray(value) ? value.slice(0, limit).map(item => clamp(item, 1000)) : [];
}

export function redactSecrets(value, key = "") {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map(item => redactSecrets(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactSecrets(childValue, childKey)]));
  }
  if (typeof value !== "string") return value;
  const redacted = SECRET_VALUE_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
  return redacted.replace(/((?:api.?key|authorization|cookie|credential|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function searchText(score) {
  const metadata = score.metadata || {};
  return [score.id, score.traceId, metadata.sessionId, metadata.pathKey, ...SEMANTIC_FIELDS.map(field => metadata[field])]
    .map(value => typeof value === "string" ? value : JSON.stringify(value || ""))
    .join("\n")
    .toLowerCase();
}

export function searchMemoryScores(scores, options) {
  const query = String(options.query || "").trim().toLowerCase();
  const queryTokens = query.split(/\s+/).filter(token => token.length > 1);
  const scope = ["session", "path", "all"].includes(options.scope) ? options.scope : "session";

  return scores
    .filter(score => {
      const metadata = score.metadata || {};
      if (scope === "session" && options.sessionId && metadata.sessionId !== options.sessionId) return false;
      if (scope !== "all" && options.pathKey && metadata.pathKey !== options.pathKey) return false;
      if (options.traceId && (score.traceId || metadata.traceId) !== options.traceId) return false;
      if (options.scoreId && score.id !== options.scoreId) return false;
      return true;
    })
    .map(score => {
      const text = searchText(score);
      let rank = 0;
      if (options.scoreId && score.id === options.scoreId) rank += 1000;
      if (options.traceId && (score.traceId || score.metadata?.traceId) === options.traceId) rank += 500;
      if (query && text.includes(query)) rank += 100;
      rank += queryTokens.filter(token => text.includes(token)).length * 10;
      return { score, rank };
    })
    .filter(result => !query || result.rank > 0)
    .sort((a, b) => b.rank - a.rank || String(b.score.metadata?.generatedAt || b.score.createdAt || "").localeCompare(String(a.score.metadata?.generatedAt || a.score.createdAt || "")))
    .slice(0, Math.max(1, Math.min(Number(options.limit) || 5, 20)));
}

export function formatMemoryResult(score) {
  const metadata = score.metadata || {};
  const result = {
    type: score.name === "memory_session_reflection" ? "reflection" : "observation",
    scoreId: score.id,
    traceId: score.traceId || metadata.traceId || null,
    sessionId: metadata.sessionId || score.sessionId || null,
    pathKey: metadata.pathKey || null,
    promptVersion: metadata.promptVersion || null,
    generation: metadata.generation || null,
    generatedAt: metadata.generatedAt || score.createdAt || null,
    traceTimestamp: metadata.traceTimestamp || null,
    coveredUntil: metadata.coveredUntil || null,
    sourceObservationCount: metadata.sourceObservationCount || null,
    summary: clamp(metadata.summary || score.comment || "", 1500),
    goal: strings(metadata.goal),
    constraints: strings(metadata.constraints),
    currentTask: clamp(metadata.currentTask, 1500),
    taskStatus: metadata.taskStatus || null,
    completed: strings(metadata.completed, 15),
    inProgress: strings(metadata.inProgress, 15),
    openIssues: strings(metadata.openIssues, 15),
    decisions: strings(metadata.decisions, 15),
    nextSteps: strings(metadata.nextSteps, 15),
    criticalContext: strings(metadata.criticalContext, 20),
    filesRead: strings(metadata.filesRead, 20),
    filesModified: strings(metadata.filesModified, 20),
    filesCreated: strings(metadata.filesCreated, 20),
    filesDeleted: strings(metadata.filesDeleted, 20),
    toolsUsed: strings(metadata.toolsUsed, 20),
    userRequests: Array.isArray(metadata.userRequests) ? metadata.userRequests.slice(0, 10) : [],
    questionsAnswered: Array.isArray(metadata.questionsAnswered) ? metadata.questionsAnswered.slice(0, 10) : [],
    corrections: Array.isArray(metadata.corrections) ? metadata.corrections.slice(0, 10) : [],
    durableItems: Array.isArray(metadata.durableItems) ? metadata.durableItems.slice(0, 30) : [],
    activeDecisions: Array.isArray(metadata.activeDecisions) ? metadata.activeDecisions.slice(0, 20) : [],
    activeConstraints: Array.isArray(metadata.activeConstraints) ? metadata.activeConstraints.slice(0, 20) : [],
    supersededItems: Array.isArray(metadata.supersededItems) ? metadata.supersededItems.slice(0, 20) : [],
    memoryStatus: metadata.memoryStatus || null,
    replacementEligible: metadata.replacementEligible ?? metadata.semanticCoverageComplete ?? null,
    semanticCoverage: metadata.semanticCoverage || null,
    excerpt: clamp(metadata.reflectionMarkdown || metadata.observationsMarkdown || "", 4000),
    sourceTraceIds: strings(metadata.sourceTraceIds, 20),
    sourceObservationScoreIds: strings(metadata.sourceObservationScoreIds, 20),
    sourceReflectionScoreIds: strings(metadata.sourceReflectionScoreIds, 20),
    piProvenanceVersion: metadata.piProvenanceVersion || null,
    piProvenanceStatus: metadata.piProvenanceStatus || null,
    piProvenanceComplete: metadata.piProvenanceComplete ?? metadata.piProvenance?.complete ?? null,
    piSessionId: metadata.piSessionId || metadata.piProvenance?.piSessionId || null,
    piUserEntryId: metadata.piUserEntryId || metadata.piProvenance?.userEntryId || null,
    piFirstEntryId: metadata.piFirstEntryId || metadata.piProvenance?.firstEntryId || null,
    piLastEntryId: metadata.piLastEntryId || metadata.piProvenance?.lastEntryId || null,
    coveredThroughPiEntryId: metadata.coveredThroughPiEntryId || null,
    piEntryIds: strings(metadata.piEntryIds || metadata.piProvenance?.entryIds, 100),
    piMessageEntryIds: strings(metadata.piMessageEntryIds || metadata.piProvenance?.messageEntryIds, 100),
    missingPiProvenanceScoreIds: strings(metadata.missingPiProvenanceScoreIds, 100),
    piUnexecutedToolCallIds: strings(metadata.piUnexecutedToolCallIds || metadata.piProvenance?.unexecutedToolCallIds, 100),
    piToolPairs: Array.isArray(metadata.piToolPairs || metadata.piProvenance?.toolPairs)
      ? (metadata.piToolPairs || metadata.piProvenance.toolPairs).slice(0, 100)
      : [],
  };
  return redactSecrets(result);
}
