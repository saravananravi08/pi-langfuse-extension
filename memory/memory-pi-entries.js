import { basename, join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { redactSecrets } from "./memory-lookup.js";

function parseJsonLines(raw) {
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  return entries;
}

function bounded(value, maxChars) {
  const text = typeof value === "string" ? value : JSON.stringify(redactSecrets(value));
  if (!text || text.length <= maxChars) return redactSecrets(value);
  return `${text.slice(0, maxChars)}...[truncated ${text.length - maxChars} chars]`;
}

export function findPiSessionFile(sessionsRoot, sessionId, piSessionId = "", currentSessionFile = "") {
  if (currentSessionFile && existsSync(currentSessionFile)) {
    const header = parseJsonLines(readFileSync(currentSessionFile, "utf8"))[0];
    if (basename(currentSessionFile, ".jsonl") === sessionId || (piSessionId && header?.id === piSessionId)) return currentSessionFile;
  }
  if (!existsSync(sessionsRoot)) return "";
  const expectedName = sessionId ? `${basename(sessionId, ".jsonl")}.jsonl` : "";
  for (const relative of readdirSync(sessionsRoot, { recursive: true, encoding: "utf8" })) {
    if (!String(relative).endsWith(".jsonl")) continue;
    const path = join(sessionsRoot, String(relative));
    if (expectedName && basename(path) === expectedName) return path;
    if (piSessionId) {
      const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
      try { if (JSON.parse(firstLine).id === piSessionId) return path; } catch {}
    }
  }
  return "";
}

export function readBoundedPiEntries(sessionFile, requestedEntryIds, maxEntries = 50, maxCharsPerEntry = 3000) {
  const requested = [...new Set(requestedEntryIds.filter(Boolean))].slice(0, maxEntries);
  if (!sessionFile || !existsSync(sessionFile)) {
    return { entries: [], requestedEntryCount: requestedEntryIds.length, returnedEntryCount: 0, missingEntryIds: requested, truncated: requestedEntryIds.length > maxEntries };
  }
  const wanted = new Set(requested);
  const entries = parseJsonLines(readFileSync(sessionFile, "utf8"))
    .filter(entry => wanted.has(entry.id))
    .map(entry => ({
      id: entry.id,
      parentId: entry.parentId || null,
      timestamp: entry.timestamp || null,
      type: entry.type,
      role: entry.message?.role || null,
      toolCallId: entry.message?.toolCallId || null,
      customType: entry.customType || null,
      content: bounded(entry.message?.content ?? entry.content ?? entry.summary ?? null, maxCharsPerEntry),
    }));
  const returned = new Set(entries.map(entry => entry.id));
  return {
    entries,
    requestedEntryCount: requestedEntryIds.length,
    returnedEntryCount: entries.length,
    missingEntryIds: requested.filter(id => !returned.has(id)),
    truncated: requestedEntryIds.length > maxEntries,
  };
}

export function provenanceEntryIds(scores, maxEntries = 50) {
  const ids = [];
  for (const score of scores) {
    const metadata = score?.metadata || {};
    const provenance = metadata.piProvenance || {};
    const values = metadata.sourcePiEntryIds || metadata.piEntryIds || provenance.entryIds || [];
    if (Array.isArray(values)) ids.push(...values);
  }
  return [...new Set(ids.filter(Boolean))].slice(0, maxEntries);
}
