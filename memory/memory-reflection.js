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

function uniqueStrings(value) {
  return [...new Set(strings(value))];
}

function durableLine(item) {
  const sourceEntryIds = Array.isArray(item.sourceEntryIds) ? item.sourceEntryIds.filter(Boolean) : [];
  const visibleSources = sourceEntryIds.slice(-3);
  const omitted = sourceEntryIds.length - visibleSources.length;
  const sources = `${visibleSources.join(", ")}${omitted > 0 ? ` (+${omitted} older)` : ""}`;
  return `[${item.authority}/${item.status}] ${item.topic}: ${item.content} (sources: ${sources})`;
}

function omission(count, label) {
  return count > 0 ? [`${count} ${label} omitted from rendered checkpoint; retained in canonical memory.`] : [];
}

function renderBudgetState(fields, selected, includeCurrentTask) {
  const visible = (field, label) => {
    const all = uniqueStrings(fields[field]);
    const values = all.filter(item => selected[field].has(item));
    return [...values, ...omission(all.length - values.length, label)];
  };
  const durable = (predicate, label) => {
    const all = (Array.isArray(fields.durableItems) ? fields.durableItems : []).filter(predicate);
    const values = all.filter(item => selected.durableItems.has(item)).map(durableLine);
    return [...values, ...omission(all.length - values.length, label)];
  };
  const progress = [];
  const currentTask = String(fields.currentTask || "").trim();
  if (currentTask) progress.push(includeCurrentTask ? `Current task: ${currentTask}` : "Current task omitted from rendered checkpoint; retained in canonical memory.");
  if (String(fields.taskStatus || "").trim()) progress.push(`Status: ${String(fields.taskStatus).trim()}`);

  return [
    section("## Goal", visible("goal", "goals")),
    [section("## Constraints & Preferences", visible("constraints", "constraints")), section("### Active User Requests", durable(item => item.status === "active" && item.kind === "request", "active user requests")), section("### Active Decisions", durable(item => item.status === "active" && item.kind === "decision", "active decisions")), section("### Active Constraints", durable(item => item.status === "active" && item.kind === "constraint", "active constraints"))].join("\n"),
    ["## Progress", markdownItems(progress), section("### Done", visible("completed", "older completed outcomes")), section("### In Progress", visible("inProgress", "in-progress items")), section("### Blocked", visible("openIssues", "open issues"))].filter(Boolean).join("\n"),
    section("## Key Decisions", visible("decisions", "older decisions")),
    section("## Next Steps", visible("nextSteps", "next steps"), true),
    [section("## Critical Context", visible("criticalContext", "older context items")), section("### Files Read", visible("filesRead", "older files read")), section("### Files Modified", visible("filesModified", "older modified files")), section("### Files Created", visible("filesCreated", "older created files")), section("### Files Deleted", visible("filesDeleted", "older deleted files")), section("### Tools Used", visible("toolsUsed", "older tools"))].join("\n"),
  ].join("\n\n");
}

export function renderReflectionMarkdown(fields, options = {}) {
  const maxTokens = Math.max(1_000, Number(options.maxTokens) || 10_000);
  const selected = Object.fromEntries(ARRAY_FIELDS.map(field => [field, new Set()]));
  selected.durableItems = new Set();
  let includeCurrentTask = false;
  const fits = () => Math.ceil(renderBudgetState(fields, selected, includeCurrentTask).length / 4) <= maxTokens;
  const add = (field, item) => {
    if (field === "currentTask") includeCurrentTask = true;
    else selected[field].add(item);
    if (fits()) return;
    if (field === "currentTask") includeCurrentTask = false;
    else selected[field].delete(item);
  };
  const activeDurable = (Array.isArray(fields.durableItems) ? fields.durableItems : [])
    .filter(item => item?.status === "active" && ["request", "constraint", "decision"].includes(item.kind));
  const recent = (field, limit) => uniqueStrings(fields[field]).slice(-limit).reverse();
  const groups = [
    ["currentTask", String(fields.currentTask || "").trim() ? [String(fields.currentTask).trim()] : []],
    ["goal", uniqueStrings(fields.goal)],
    ["durableItems", activeDurable.filter(item => item.kind === "request")],
    ["constraints", uniqueStrings(fields.constraints)],
    ["durableItems", activeDurable.filter(item => item.kind !== "request")],
    ["inProgress", uniqueStrings(fields.inProgress)],
    ["openIssues", uniqueStrings(fields.openIssues)],
    ["nextSteps", uniqueStrings(fields.nextSteps)],
    ["decisions", recent("decisions", 30)],
    ["completed", recent("completed", 40)],
    ["criticalContext", recent("criticalContext", 40)],
    ["filesModified", recent("filesModified", 50)],
    ["filesCreated", recent("filesCreated", 30)],
    ["filesDeleted", recent("filesDeleted", 30)],
    ["filesRead", recent("filesRead", 50)],
    ["toolsUsed", recent("toolsUsed", 30)],
  ];
  for (const [field, items] of groups) for (const item of items) add(field, item);
  return renderBudgetState(fields, selected, includeCurrentTask);
}

export function normalizeReflectionTaskStatus(fields) {
  if (fields.taskStatus !== "complete" || (!strings(fields.inProgress).length && !strings(fields.openIssues).length)) return fields;
  return { ...fields, taskStatus: "active" };
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
