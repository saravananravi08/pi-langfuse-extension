import { generatedAt, latestReflection, metadataString } from "./memory-state.js";

export function createMemoryCache(ttlMs = 300_000, now = Date.now) {
  const entries = new Map();

  function getEntry(key) {
    let entry = entries.get(key);
    if (!entry) {
      entry = { observations: new Map(), reflection: undefined, loadedAt: undefined };
      entries.set(key, entry);
    }
    return entry;
  }

  function pruneCovered(entry) {
    const coveredUntil = metadataString(entry.reflection, "coveredUntil");
    if (!coveredUntil) return;
    for (const [id, observation] of entry.observations) {
      if (generatedAt(observation) <= coveredUntil) entry.observations.delete(id);
    }
  }

  return {
    needsRefresh(key) {
      const loadedAt = entries.get(key)?.loadedAt;
      return loadedAt === undefined || now() - loadedAt >= ttlMs;
    },

    mergeRemote(key, observations, reflections) {
      const entry = getEntry(key);
      for (const observation of observations) entry.observations.set(observation.id, observation);
      entry.reflection = latestReflection([entry.reflection, ...reflections].filter(Boolean));
      entry.loadedAt = now();
      pruneCovered(entry);
    },

    addObservation(key, observation) {
      const entry = getEntry(key);
      entry.observations.set(observation.id, observation);
      pruneCovered(entry);
    },

    setReflection(key, reflection) {
      const entry = getEntry(key);
      entry.reflection = latestReflection([entry.reflection, reflection].filter(Boolean));
      pruneCovered(entry);
    },

    get(key) {
      const entry = getEntry(key);
      return {
        observations: [...entry.observations.values()],
        reflection: entry.reflection,
        loadedAt: entry.loadedAt,
      };
    },

    invalidate(key) {
      if (key === undefined) entries.clear();
      else {
        const entry = entries.get(key);
        if (entry) entry.loadedAt = undefined;
      }
    },
  };
}
