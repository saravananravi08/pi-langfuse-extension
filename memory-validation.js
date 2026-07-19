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

export function validateMemoryOutput(value, kind) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "output must be a JSON object";
  const markdownField = kind === "reflection" ? "reflectionMarkdown" : "observationsMarkdown";
  if (typeof value[markdownField] !== "string" || !value[markdownField].trim()) return `${markdownField} must be a non-empty string`;
  if (typeof value.summary !== "string" || !value.summary.trim()) return "summary must be a non-empty string";
  if (typeof value.currentTask !== "string") return "currentTask must be a string";
  if (typeof value.taskStatus !== "string" || !value.taskStatus.trim()) return "taskStatus must be a non-empty string";
  for (const field of MEMORY_ARRAY_FIELDS) {
    if (!Array.isArray(value[field]) || value[field].some(item => typeof item !== "string")) return `${field} must be an array of strings`;
  }
  return undefined;
}
