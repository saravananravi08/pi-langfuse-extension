function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function aggregatePiReflectionProvenance(previousMetadata, observations) {
  const items = observations.map(score => ({ score, provenance: score.metadata?.piProvenance }));
  const missingPiProvenanceScoreIds = items.filter(item => !item.provenance?.complete).map(item => item.score.id);
  const previousRanges = Array.isArray(previousMetadata?.sourcePiRanges) ? previousMetadata.sourcePiRanges : [];
  const previousToolPairs = Array.isArray(previousMetadata?.sourcePiToolPairs) ? previousMetadata.sourcePiToolPairs : [];
  const sourcePiUnexecutedToolCallIds = unique([
    ...(Array.isArray(previousMetadata?.sourcePiUnexecutedToolCallIds) ? previousMetadata.sourcePiUnexecutedToolCallIds : []),
    ...items.flatMap(item => item.provenance?.unexecutedToolCallIds || []),
  ]);
  const sourcePiSessionIds = unique([
    ...(Array.isArray(previousMetadata?.sourcePiSessionIds) ? previousMetadata.sourcePiSessionIds : []),
    ...items.map(item => item.provenance?.piSessionId),
  ]);
  const sourcePiEntryIds = unique([
    ...(Array.isArray(previousMetadata?.sourcePiEntryIds) ? previousMetadata.sourcePiEntryIds : []),
    ...items.flatMap(item => item.provenance?.entryIds || []),
  ]);
  const sourcePiRanges = [
    ...previousRanges,
    ...items.filter(item => item.provenance).map(item => ({
      observationScoreId: item.score.id,
      traceId: item.score.traceId || item.score.metadata?.traceId || null,
      firstEntryId: item.provenance.firstEntryId,
      lastEntryId: item.provenance.lastEntryId,
      entryIds: item.provenance.entryIds,
    })),
  ];
  const sourcePiToolPairs = [
    ...previousToolPairs,
    ...items.flatMap(item => {
      const unexecuted = new Set(item.provenance?.unexecutedToolCallIds || []);
      return (item.provenance?.toolPairs || []).filter(pair => !unexecuted.has(pair.toolCallId)).map(pair => ({
        observationScoreId: item.score.id,
        traceId: item.score.traceId || item.score.metadata?.traceId || null,
        ...pair,
      }));
    }),
  ];
  const previousComplete = previousMetadata ? previousMetadata.piProvenanceComplete === true : true;
  return {
    piProvenanceVersion: "pi-entry-v1",
    piProvenanceComplete: previousComplete && missingPiProvenanceScoreIds.length === 0,
    missingPiProvenanceScoreIds,
    sourcePiSessionIds,
    sourcePiEntryIds,
    sourcePiRanges,
    sourcePiToolPairs,
    sourcePiUnexecutedToolCallIds,
    coveredThroughPiEntryId: items.at(-1)?.provenance?.lastEntryId || null,
  };
}

export function findPiTraceStartEntryId(entries, parentEntryId) {
  if (!entries.length) return "";
  if (!parentEntryId) return entries.find(entry => entry?.type === "message" && entry.message?.role === "user")?.id || "";
  const parentIndex = entries.findIndex(entry => entry?.id === parentEntryId);
  if (parentIndex < 0) return "";
  return entries.slice(parentIndex + 1).find(entry => entry?.type === "message" && entry.message?.role === "user")?.id || "";
}

export function buildPiTraceProvenance(entries, startEntryId, piSessionId, endEntryId = "", allowNonUserStart = false) {
  const errors = [];
  const startIndex = entries.findIndex(entry => entry?.id === startEntryId);
  if (!startEntryId || startIndex < 0) {
    return { provenance: undefined, errors: [startEntryId ? "start entry is not on current branch" : "start entry id is missing"] };
  }

  const requestedEndIndex = endEntryId ? entries.findIndex(entry => entry?.id === endEntryId) : entries.length - 1;
  if (requestedEndIndex < startIndex) {
    return { provenance: undefined, errors: [endEntryId ? "end entry is not after start entry" : "range end is missing"] };
  }
  const range = entries.slice(startIndex, requestedEndIndex + 1);
  const first = range[0];
  const last = range.at(-1);
  if (!allowNonUserStart && (first?.type !== "message" || first.message?.role !== "user")) errors.push("range does not start with a user message");

  const messageEntries = range.filter(entry => entry?.type === "message");
  const userEntries = messageEntries.filter(entry => entry.message?.role === "user");
  const assistantEntries = messageEntries.filter(entry => entry.message?.role === "assistant");
  const resultEntries = messageEntries.filter(entry => entry.message?.role === "toolResult");
  const calls = new Map();
  const unexecutedToolCallIds = [];
  for (const entry of assistantEntries) {
    for (const part of Array.isArray(entry.message?.content) ? entry.message.content : []) {
      if (part?.type !== "toolCall" || !part.id) continue;
      if (["aborted", "error"].includes(entry.message?.stopReason)) {
        unexecutedToolCallIds.push(part.id);
        continue;
      }
      if (calls.has(part.id)) errors.push(`duplicate tool call id ${part.id}`);
      calls.set(part.id, { toolCallId: part.id, toolName: part.name || null, assistantEntryId: entry.id });
    }
  }

  const results = new Map();
  for (const entry of resultEntries) {
    const toolCallId = entry.message?.toolCallId;
    if (!toolCallId) continue;
    if (results.has(toolCallId)) errors.push(`duplicate tool result id ${toolCallId}`);
    results.set(toolCallId, entry);
  }

  const toolPairs = [...calls.values()].map(call => ({
    ...call,
    toolResultEntryId: results.get(call.toolCallId)?.id || null,
  }));
  const missingToolResultIds = toolPairs.filter(pair => !pair.toolResultEntryId).map(pair => pair.toolCallId);
  const orphanToolResultIds = [...results.keys()].filter(toolCallId => !calls.has(toolCallId));
  if (missingToolResultIds.length) errors.push(`${missingToolResultIds.length} tool call(s) have no result entry`);
  if (orphanToolResultIds.length) errors.push(`${orphanToolResultIds.length} tool result(s) have no assistant call entry`);
  if (!last?.id) errors.push("range has no last entry");

  return {
    provenance: {
      version: "pi-entry-v1",
      piSessionId: piSessionId || null,
      firstEntryId: first?.id || null,
      lastEntryId: last?.id || null,
      startEntryParentId: first?.parentId || null,
      branchLeafEntryId: last?.id || null,
      entryIds: range.map(entry => entry.id).filter(Boolean),
      messageEntryIds: messageEntries.map(entry => entry.id),
      userEntryId: userEntries[0]?.id || null,
      userEntryIds: userEntries.map(entry => entry.id),
      assistantEntryIds: assistantEntries.map(entry => entry.id),
      toolResultEntryIds: resultEntries.map(entry => entry.id),
      toolPairs,
      missingToolResultIds,
      orphanToolResultIds,
      unexecutedToolCallIds,
      complete: errors.length === 0,
    },
    errors,
  };
}
