export const MEMORY_ARRAY_FIELDS = [
  "goal",
  "constraints",
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
  "toolsUsed",
];

function objectArray(value, field) {
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) return `${field} must be an array of objects`;
}

function validateDurableItems(value) {
  const arrayError = objectArray(value, "durableItems");
  if (arrayError) return arrayError;
  for (const item of value) {
    if (typeof item.topic !== "string" || !item.topic.trim()) return "durableItems topic must be a non-empty string";
    if (typeof item.content !== "string" || !item.content.trim()) return "durableItems content must be a non-empty string";
    if (!["request", "decision", "constraint", "fact", "task", "question", "commitment"].includes(item.kind)) return "durableItems kind is invalid";
    if (!["user", "verified-result", "assistant-proposal"].includes(item.authority)) return "durableItems authority is invalid";
    if (!["active", "completed", "superseded", "revoked", "proposed"].includes(item.status)) return "durableItems status is invalid";
    if (!Array.isArray(item.sourceEntryIds) || !item.sourceEntryIds.length || item.sourceEntryIds.some(id => typeof id !== "string" || !id)) return "durableItems sourceEntryIds must be a non-empty array of strings";
  }
}

export function validateMemoryOutput(value, kind) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "output must be a JSON object";
  if (kind === "observer" && (typeof value.observationsMarkdown !== "string" || !value.observationsMarkdown.trim())) return "observationsMarkdown must be a non-empty string";
  if (typeof value.summary !== "string" || !value.summary.trim()) return "summary must be a non-empty string";
  if (typeof value.currentTask !== "string") return "currentTask must be a string";
  if (typeof value.taskStatus !== "string" || !value.taskStatus.trim()) return "taskStatus must be a non-empty string";
  for (const field of MEMORY_ARRAY_FIELDS) {
    if (!Array.isArray(value[field]) || value[field].some(item => typeof item !== "string")) return `${field} must be an array of strings`;
  }
  const durableError = validateDurableItems(value.durableItems);
  if (durableError) return durableError;
  if (kind === "observer") {
    for (const field of ["userRequests", "questionsAnswered", "corrections", "commitments", "evidence"]) {
      const error = objectArray(value[field], field);
      if (error) return error;
    }
    if (!value.taskDelta || typeof value.taskDelta !== "object" || Array.isArray(value.taskDelta)) return "taskDelta must be an object";
  }
  return undefined;
}
