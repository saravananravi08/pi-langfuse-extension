import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryCache } from '../memory-cache.js';

function score(id, generatedAt, extra = {}) {
  return {
    id,
    metadata: {
      version: 'v1',
      sessionId: 'session-a',
      pathKey: '/project-a',
      generatedAt,
      ...extra,
    },
  };
}

function reflection(id, generation, generatedAt, coveredUntil) {
  return score(id, generatedAt, { generation, coveredUntil, reflectionMarkdown: id });
}

test('remote state is fetched once per TTL window', () => {
  let now = 1_000;
  const cache = createMemoryCache(300_000, () => now);

  assert.equal(cache.needsRefresh('scope'), true);
  cache.mergeRemote('scope', [], []);
  assert.equal(cache.needsRefresh('scope'), false);
  now += 299_999;
  assert.equal(cache.needsRefresh('scope'), false);
  now += 1;
  assert.equal(cache.needsRefresh('scope'), true);
});

test('observations are write-through, deduplicated, and isolated by scope', () => {
  const cache = createMemoryCache();
  const observation = score('observation', '2026-01-02T00:00:00Z');

  cache.addObservation('scope-a', observation);
  cache.addObservation('scope-a', observation);
  assert.deepEqual(cache.get('scope-a').observations.map(item => item.id), ['observation']);
  assert.deepEqual(cache.get('scope-b').observations, []);
});

test('newest reflection wins and covered observations are pruned', () => {
  const cache = createMemoryCache();
  cache.addObservation('scope', score('covered', '2026-01-02T00:00:00Z'));
  cache.addObservation('scope', score('fresh', '2026-01-04T00:00:00Z'));
  cache.setReflection('scope', reflection('local-g2', 2, '2026-01-05T00:00:00Z', '2026-01-02T00:00:00Z'));
  cache.mergeRemote('scope', [score('covered', '2026-01-02T00:00:00Z')], [
    reflection('older-g1', 1, '2026-01-06T00:00:00Z', '2026-01-01T00:00:00Z'),
  ]);

  const state = cache.get('scope');
  assert.equal(state.reflection.id, 'local-g2');
  assert.deepEqual(state.observations.map(item => item.id), ['fresh']);
});

test('external newer reflection supersedes local state on refresh', () => {
  const cache = createMemoryCache();
  cache.setReflection('scope', reflection('local-g1', 1, '2026-01-03T00:00:00Z', '2026-01-01T00:00:00Z'));
  cache.mergeRemote('scope', [], [reflection('external-g2', 2, '2026-01-04T00:00:00Z', '2026-01-02T00:00:00Z')]);
  assert.equal(cache.get('scope').reflection.id, 'external-g2');
});

test('invalidation forces refresh without discarding write-through state', () => {
  const cache = createMemoryCache();
  cache.mergeRemote('scope', [], []);
  cache.addObservation('scope', score('local', '2026-01-02T00:00:00Z'));
  cache.invalidate('scope');

  assert.equal(cache.needsRefresh('scope'), true);
  assert.deepEqual(cache.get('scope').observations.map(item => item.id), ['local']);
});
