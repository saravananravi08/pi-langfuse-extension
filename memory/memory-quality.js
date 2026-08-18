import { createHash } from "node:crypto";

const AUTHORITY_RANK = {
  "assistant-proposal": 1,
  "verified-result": 2,
  user: 3,
};

const VALID_STATUSES = new Set(["active", "completed", "superseded", "revoked", "proposed"]);
const VALID_AUTHORITIES = new Set(Object.keys(AUTHORITY_RANK));
const VALID_KINDS = new Set(["request", "decision", "constraint", "fact", "task", "question", "commitment"]);

function strings(value) {
  return Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : [];
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content.trim();
  return (Array.isArray(message?.content) ? message.content : [])
    .filter(part => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text.trim())
    .filter(Boolean)
    .join("\n");
}

function stableId(kind, topic) {
  const normalized = `${kind}:${topic}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  if (normalized) return normalized;
  return `${kind}-${createHash("sha256").update(topic).digest("hex").slice(0, 12)}`;
}

function timestamp(entry) {
  const value = entry?.timestamp || entry?.message?.timestamp;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function meaningfulTokens(text) {
  return [...new Set(String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 2 && !["the", "and", "that", "this", "with", "from", "have", "been", "because", "otherwise"].includes(token)))];
}

export function textSupportsClaim(sourceText, claimText, minimumRatio = 0.4) {
  const source = new Set(meaningfulTokens(sourceText));
  const claim = meaningfulTokens(claimText);
  if (!source.size || !claim.length) return false;
  return claim.filter(token => source.has(token)).length / claim.length >= minimumRatio;
}

export function detectExplicitCorrection(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  return /\b(?:no|don't|do not|instead|rather than|not anymore|no longer|moved to|replaced by|correction|i said|we decided)\b/i.test(value);
}

export function buildRecentUserRequests(branchEntries, options = {}) {
  const maxMessages = Math.max(1, Number(options.maxMessages) || 5);
  const maxTokens = Math.max(128, Number(options.maxTokens) || 2_000);
  const users = (branchEntries || [])
    .filter(entry => entry?.type === "message" && entry.message?.role === "user")
    .map(entry => ({
      entryId: String(entry.id || ""),
      text: messageText(entry.message),
      timestamp: timestamp(entry),
      correction: detectExplicitCorrection(messageText(entry.message)),
    }))
    .filter(item => item.entryId && item.text);

  const selected = [];
  let tokens = 0;
  for (const item of users.slice(-maxMessages).reverse()) {
    const itemTokens = Math.ceil(item.text.length / 4) + 20;
    if (selected.length && tokens + itemTokens > maxTokens) break;
    selected.push(item);
    tokens += itemTokens;
  }
  return selected.reverse();
}

export function classifyMemoryQuery(prompt) {
  const text = String(prompt || "").trim().toLowerCase();
  if (/\b(?:what did i ask|what (?:is|was) (?:the )?(?:question|request) i asked|what (?:question|request) did i ask|what was my (?:question|request)|previous (?:question|request)|that question|continue that|what were we discussing|do the other fixes)\b/.test(text)) return "referential";
  if (/\b(?:decid(?:e|ed|ion)|agreed|constraint|requirement|must|should not|don't|do not)\b/.test(text)) return "decision";
  if (/\b(?:what remains|what is left|status|progress|next steps?|blocked|pending)\b/.test(text)) return "progress";
  if (/\b(?:file|path|symbol|function|class|method|error|commit|branch)\b/.test(text)) return "code";
  if (/\b(?:continue|resume|proceed|go ahead|carry on)\b/.test(text)) return "continuation";
  return "general";
}

function searchable(value) {
  return JSON.stringify(value || "").toLowerCase();
}

export function rankRelevantObservations(observations, prompt, limit = 3) {
  const query = String(prompt || "").toLowerCase();
  const tokens = [...new Set(query.split(/[^a-z0-9_./-]+/).filter(token => token.length > 2))];
  const kind = classifyMemoryQuery(prompt);
  return (observations || [])
    .map((observation, index) => {
      const text = searchable(observation);
      let rank = index;
      if (query && text.includes(query)) rank += 200;
      rank += tokens.filter(token => text.includes(token)).length * 10;
      if (kind === "referential" && /userRequests|questionsAnswered/.test(JSON.stringify(observation))) rank += 100;
      if (kind === "decision" && /activeDecisions|decisions|constraints|corrections/.test(JSON.stringify(observation))) rank += 80;
      if (kind === "progress" && /activeTasks|currentTask|nextSteps|openIssues|completed/.test(JSON.stringify(observation))) rank += 60;
      return { observation, rank };
    })
    .sort((a, b) => b.rank - a.rank)
    .slice(0, Math.max(1, Number(limit) || 3))
    .map(item => item.observation);
}

export function normalizeDurableItem(value, defaults = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = VALID_KINDS.has(String(value.kind)) ? String(value.kind) : String(defaults.kind || "fact");
  const content = String(value.content || value.newUnderstanding || "").trim();
  const topic = String(value.topic || content).trim();
  const authority = VALID_AUTHORITIES.has(String(value.authority)) ? String(value.authority) : String(defaults.authority || "assistant-proposal");
  const requestedStatus = VALID_STATUSES.has(String(value.status)) ? String(value.status) : authority === "assistant-proposal" ? "proposed" : "active";
  const status = authority === "assistant-proposal" && requestedStatus === "active" ? "proposed" : requestedStatus;
  const sourceEntryIds = strings(value.sourceEntryIds || (value.sourceEntryId ? [value.sourceEntryId] : defaults.sourceEntryIds));
  const sourceScoreIds = strings(value.sourceScoreIds || defaults.sourceScoreIds);
  if (!content || !topic || !sourceEntryIds.length) return null;
  const derivedId = stableId(kind, topic);
  const suppliedId = String(value.id || "");
  const canonicalId = String(value.canonicalId || "");
  return {
    id: canonicalId || (suppliedId === derivedId || (kind === "request" && /^request-[A-Za-z0-9_-]+$/.test(suppliedId)) ? suppliedId : derivedId),
    kind,
    topic,
    content,
    status,
    authority,
    sourceEntryIds,
    sourceScoreIds,
    updatedAt: String(value.updatedAt || defaults.updatedAt || ""),
  };
}

export function sanitizeDurableItemSources(item, provenance = {}) {
  if (!item) return null;
  const userIds = new Set(strings(provenance.userEntryIds || (provenance.userEntryId ? [provenance.userEntryId] : [])));
  const resultIds = new Set(strings(provenance.toolResultEntryIds));
  const allowed = item.authority === "user" ? userIds : item.authority === "verified-result" ? resultIds : null;
  const sourceEntryIds = allowed ? strings(item.sourceEntryIds).filter(id => allowed.has(id)) : strings(item.sourceEntryIds);
  return sourceEntryIds.length ? { ...item, sourceEntryIds } : null;
}

export function validateDurableItemAuthority(item, provenance = {}) {
  const userIds = new Set(strings(provenance.userEntryIds || (provenance.userEntryId ? [provenance.userEntryId] : [])));
  const assistantIds = new Set(strings(provenance.assistantEntryIds));
  const resultIds = new Set(strings(provenance.toolResultEntryIds));
  const sources = strings(item?.sourceEntryIds);
  if (!sources.length) return false;
  if (item.authority === "user") return sources.some(id => userIds.has(id));
  if (item.authority === "verified-result") return sources.some(id => resultIds.has(id));
  return sources.some(id => userIds.has(id) || assistantIds.has(id) || resultIds.has(id));
}

export function alignDurableItems(previousItems, newItems, reflectorItems) {
  const previous = (previousItems || []).map(item => normalizeDurableItem(item)).filter(Boolean);
  return (newItems || []).map(raw => {
    const item = normalizeDurableItem(raw);
    if (!item) return raw;
    const candidate = (reflectorItems || []).find(value => {
      const sourceEntryIds = strings(value?.sourceEntryIds);
      return value?.content === item.content
        && value?.authority === item.authority
        && sourceEntryIds.length === item.sourceEntryIds.length
        && sourceEntryIds.every(id => item.sourceEntryIds.includes(id));
    });
    const target = previous.find(value => value.id === candidate?.id && value.kind === item.kind);
    return target ? { ...item, canonicalId: target.id, topic: target.topic } : item;
  });
}

export function reduceDurableItems(previousItems, candidateItems) {
  const byId = new Map();
  const superseded = [];
  const conflicts = [];
  for (const raw of previousItems || []) {
    const item = normalizeDurableItem(raw);
    if (item) byId.set(item.id, item);
  }

  for (const raw of candidateItems || []) {
    const incoming = normalizeDurableItem(raw);
    if (!incoming) continue;
    const current = byId.get(incoming.id);
    if (!current) {
      byId.set(incoming.id, incoming);
      continue;
    }
    const currentRank = AUTHORITY_RANK[current.authority] || 0;
    const incomingRank = AUTHORITY_RANK[incoming.authority] || 0;
    const newer = String(incoming.updatedAt || "").localeCompare(String(current.updatedAt || "")) >= 0;
    if (incomingRank < currentRank && ["active", "completed"].includes(current.status)) {
      if (incoming.content !== current.content) {
        conflicts.push({ topic: incoming.topic, winner: current, rejected: { ...incoming, status: "proposed" }, reason: "lower-authority update" });
      }
      continue;
    }
    if (!newer && incomingRank <= currentRank) continue;
    if (current.content !== incoming.content || current.status !== incoming.status) superseded.push({ ...current, status: "superseded" });
    byId.set(incoming.id, incoming);
  }

  const items = [...byId.values()];
  return {
    items,
    active: items.filter(item => item.status === "active"),
    proposed: items.filter(item => item.status === "proposed"),
    completed: items.filter(item => item.status === "completed"),
    superseded,
    conflicts,
  };
}

export function buildSemanticCoverage({ userRequests = [], questionsAnswered = [], corrections = [], provenance, valid = true } = {}) {
  const provenanceIds = new Set(strings(provenance?.entryIds));
  const requestIds = (userRequests || []).map(item => String(item?.entryId || "")).filter(Boolean);
  const correctionIds = (corrections || []).map(item => String(item?.sourceEntryId || "")).filter(Boolean);
  const questionIds = (questionsAnswered || []).map(item => String(item?.questionEntryId || "")).filter(Boolean);
  const allMapped = [...requestIds, ...correctionIds, ...questionIds].every(id => provenanceIds.has(id));
  const coverage = {
    userRequests: requestIds.length,
    preservedUserRequests: requestIds.filter(id => provenanceIds.has(id)).length,
    corrections: correctionIds.length,
    preservedCorrections: correctionIds.filter(id => provenanceIds.has(id)).length,
    questions: questionIds.length,
    preservedQuestions: questionIds.filter(id => provenanceIds.has(id)).length,
    unresolvedQuestions: (userRequests || []).filter(item => item?.status === "pending").length,
  };
  const complete = Boolean(valid && provenance?.complete && allMapped
    && coverage.userRequests === coverage.preservedUserRequests
    && coverage.corrections === coverage.preservedCorrections
    && coverage.questions === coverage.preservedQuestions);
  return { replacementEligible: complete, semanticCoverage: coverage };
}

export function semanticCoverageComplete(metadata) {
  const coverage = metadata?.semanticCoverage;
  return metadata?.memoryStatus === "ready"
    && metadata?.replacementEligible === true
    && coverage
    && coverage.userRequests === coverage.preservedUserRequests
    && coverage.corrections === coverage.preservedCorrections
    && coverage.questions === coverage.preservedQuestions;
}

export function prepareMetadataReplacement(value, previous) {
  if (Array.isArray(value) && Array.isArray(previous)) {
    const out = value.map((item, index) => prepareMetadataReplacement(item, previous[index]));
    const filler = value.some(item => item && typeof item === "object") ? null : "";
    while (out.length < previous.length) out.push(filler);
    return out;
  }
  if (value && typeof value === "object" && previous && typeof previous === "object" && !Array.isArray(previous)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, prepareMetadataReplacement(child, previous[key])]));
  }
  return value;
}

export function explainDurableItems(items, query) {
  const tokens = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  return (items || [])
    .map(item => ({ item, rank: tokens.filter(token => searchable(item).includes(token)).length }))
    .filter(result => !tokens.length || result.rank > 0)
    .sort((a, b) => b.rank - a.rank || String(b.item.updatedAt || "").localeCompare(String(a.item.updatedAt || "")))
    .map(result => result.item);
}
