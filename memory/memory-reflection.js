const CONTENT_FIELDS = [
  "goal",
  "constraints",
  "completed",
  "inProgress",
  "openIssues",
  "decisions",
  "nextSteps",
  "criticalContext",
];

const SOURCE_RETENTION_FIELDS = ["goal", "constraints", "completed", "decisions", "criticalContext"];
const UNRESOLVED_FIELDS = ["inProgress", "openIssues", "nextSteps"];

const ARRAY_FIELDS = [
  ...CONTENT_FIELDS,
  "filesRead",
  "filesModified",
  "filesCreated",
  "filesDeleted",
  "toolsUsed",
];

function strings(value) {
  return Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : [];
}

function normalized(value) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function markdownItems(items, ordered = false) {
  return strings(items).map((item, index) => `${ordered ? `${index + 1}.` : "-"} ${item.replace(/\n/g, "\n  ")}`).join("\n");
}

function section(heading, items, ordered = false) {
  const body = markdownItems(items, ordered);
  return body ? `${heading}\n${body}` : heading;
}

function durableLines(items, predicate) {
  return (Array.isArray(items) ? items : [])
    .filter(predicate)
    .map(item => `[${item.authority}/${item.status}] ${item.topic}: ${item.content} (sources: ${(item.sourceEntryIds || []).join(", ")})`);
}

export function renderReflectionMarkdown(fields) {
  const progress = [];
  if (String(fields.currentTask || "").trim()) progress.push(`Current task: ${String(fields.currentTask).trim()}`);
  if (String(fields.taskStatus || "").trim()) progress.push(`Status: ${String(fields.taskStatus).trim()}`);

  return [
    section("## Goal", fields.goal),
    [section("## Constraints & Preferences", fields.constraints), section("### Active User Requests", durableLines(fields.durableItems, item => item.status === "active" && item.kind === "request")), section("### Active Decisions", durableLines(fields.durableItems, item => item.status === "active" && item.kind === "decision")), section("### Active Constraints", durableLines(fields.durableItems, item => item.status === "active" && item.kind === "constraint"))].join("\n"),
    ["## Progress", markdownItems(progress), section("### Done", fields.completed), section("### In Progress", fields.inProgress), section("### Blocked", fields.openIssues)].filter(Boolean).join("\n"),
    section("## Key Decisions", fields.decisions),
    section("## Next Steps", fields.nextSteps, true),
    [section("## Critical Context", fields.criticalContext), section("### Files Read", fields.filesRead), section("### Files Modified", fields.filesModified), section("### Files Created", fields.filesCreated), section("### Files Deleted", fields.filesDeleted), section("### Tools Used", fields.toolsUsed)].join("\n"),
  ].join("\n\n");
}

export function evaluateReflectionQuality(output, previous, observations) {
  const sources = [previous, ...(observations || [])].filter(Boolean);
  const sourceFields = SOURCE_RETENTION_FIELDS.filter(field => sources.some(source => strings(source[field]).length > 0));
  const retainedFields = sourceFields.filter(field => strings(output[field]).length > 0);
  const missingSourceFields = sourceFields.filter(field => !retainedFields.includes(field));

  let itemCount = 0;
  let duplicateCount = 0;
  const duplicateFields = [];
  for (const field of ARRAY_FIELDS) {
    const seen = new Set();
    const items = strings(output[field]);
    let fieldDuplicates = 0;
    for (const item of items) {
      itemCount++;
      const key = normalized(item);
      if (seen.has(key)) {
        duplicateCount++;
        fieldDuplicates++;
      } else seen.add(key);
    }
    if (fieldDuplicates >= 2 && fieldDuplicates / Math.max(items.length, 1) > 0.2) duplicateFields.push(field);
  }

  const contradictions = [];
  if (output.taskStatus === "complete" && (strings(output.inProgress).length || strings(output.openIssues).length)) {
    contradictions.push("complete status has unfinished or blocked items");
  }
  const durableItems = Array.isArray(output.durableItems) ? output.durableItems : [];
  const activeById = new Map();
  for (const item of durableItems.filter(item => item?.status === "active")) {
    const previousItem = activeById.get(item.id);
    if (previousItem && previousItem.content !== item.content) contradictions.push(`conflicting active durable item ${item.id}`);
    activeById.set(item.id, item);
  }
  const previousDurable = sources.flatMap(source => Array.isArray(source?.durableItems) ? source.durableItems : []);
  const lostUserItems = previousDurable.filter(item => item?.authority === "user" && item?.status === "active")
    .filter(item => !durableItems.some(candidate => candidate?.id === item.id));

  const errors = [];
  if (!strings(output.goal).length) errors.push("goal is empty");
  if (String(output.taskStatus || "") !== "complete" && !strings(output.nextSteps).length) errors.push("non-complete task has no next steps");
  if (missingSourceFields.length) errors.push(`durable source fields became empty: ${missingSourceFields.join(", ")}`);
  if (lostUserItems.length) errors.push(`active user durable items disappeared: ${lostUserItems.map(item => item.id).join(", ")}`);
  const sourceHasUnresolvedWork = UNRESOLVED_FIELDS.some(field => sources.some(source => strings(source[field]).length > 0));
  const outputTracksWork = [...UNRESOLVED_FIELDS, "completed"].some(field => strings(output[field]).length > 0);
  if (sourceHasUnresolvedWork && !outputTracksWork) errors.push("source work disappeared without a resulting state");
  if (duplicateFields.length) errors.push(`structured fields contain excessive exact duplicates: ${duplicateFields.join(", ")}`);
  errors.push(...contradictions);

  return {
    errors,
    metrics: {
      deterministicMarkdown: true,
      sourceNonEmptyFieldCount: sourceFields.length,
      retainedNonEmptyFieldCount: retainedFields.length,
      fieldRetentionRatio: sourceFields.length ? Number((retainedFields.length / sourceFields.length).toFixed(3)) : 1,
      missingSourceFields,
      structuredItemCount: itemCount,
      duplicateItemCount: duplicateCount,
      duplicateFields,
      contradictionCount: contradictions.length,
      durableItemCount: durableItems.length,
      lostUserItemCount: lostUserItems.length,
    },
  };
}
