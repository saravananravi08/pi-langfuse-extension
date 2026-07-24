import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SCHEMA_VERSION = 1;
const MAX_CACHE_BYTES = 20 * 1024 * 1024;

function hash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function safeSessionId(value) {
  return String(value || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 220);
}

function validScore(score, sessionId, pathKey) {
  return Boolean(score && typeof score === "object" && typeof score.id === "string" && score.id
    && score.metadata && typeof score.metadata === "object"
    && score.metadata.sessionId === sessionId
    && score.metadata.pathKey === pathKey
    && ["v1", "v2"].includes(String(score.metadata.version || "")));
}

function pruneCovered(scores) {
  const covered = new Set(scores.filter(score => score.name === "memory_session_reflection").flatMap(score => [
    ...(Array.isArray(score.metadata?.sourceObservationScoreIds) ? score.metadata.sourceObservationScoreIds : []),
    ...(Array.isArray(score.metadata?.sourcePiRanges) ? score.metadata.sourcePiRanges.map(range => range?.observationScoreId) : []),
  ]).map(String).filter(Boolean));
  return scores.filter(score => score.name !== "memory_trace_observation" || !covered.has(score.id));
}

export function createMemoryDiskCache({ rootDir, host, projectKey }) {
  const projectKeyHash = hash(projectKey).slice(0, 16);
  const hostKey = String(host || "").replace(/\/+$/, "");

  function filePath(sessionId, pathKey) {
    return join(rootDir, hash(pathKey).slice(0, 16), `${safeSessionId(sessionId)}.json`);
  }

  async function load(scope) {
    const path = filePath(scope.sessionId, scope.pathKey);
    try {
      if ((await stat(path)).size > MAX_CACHE_BYTES) return undefined;
      const payload = JSON.parse(await readFile(path, "utf8"));
      if (payload.schemaVersion !== SCHEMA_VERSION
        || payload.sessionId !== scope.sessionId
        || payload.pathKey !== scope.pathKey
        || payload.langfuseHost !== hostKey
        || payload.projectKeyHash !== projectKeyHash
        || !Array.isArray(payload.scores)) return undefined;
      const scores = payload.scores.filter(score => validScore(score, scope.sessionId, scope.pathKey));
      if (scores.length !== payload.scores.length) return undefined;
      return { scores, savedAt: String(payload.savedAt || ""), branchLeafEntryId: String(payload.branchLeafEntryId || "") };
    } catch {
      return undefined;
    }
  }

  async function save(scope, scores) {
    const valid = pruneCovered(scores.filter(score => validScore(score, scope.sessionId, scope.pathKey)));
    const path = filePath(scope.sessionId, scope.pathKey);
    const directory = join(rootDir, hash(scope.pathKey).slice(0, 16));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await Promise.all([chmod(rootDir, 0o700), chmod(directory, 0o700)]);
    const payload = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      sessionId: scope.sessionId,
      piSessionId: scope.piSessionId || null,
      pathKey: scope.pathKey,
      langfuseHost: hostKey,
      projectKeyHash,
      branchLeafEntryId: scope.branchLeafEntryId || null,
      savedAt: new Date().toISOString(),
      scores: valid,
    });
    if (Buffer.byteLength(payload) > MAX_CACHE_BYTES) return false;
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, payload, { mode: 0o600 });
      await rename(temporary, path);
      await chmod(path, 0o600);
      return true;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async function merge(scope, scores) {
    const existing = await load(scope);
    const merged = new Map((existing?.scores || []).map(score => [score.id, score]));
    for (const score of scores) if (validScore(score, scope.sessionId, scope.pathKey)) merged.set(score.id, score);
    return save(scope, [...merged.values()]);
  }

  return { filePath, load, save, merge };
}
