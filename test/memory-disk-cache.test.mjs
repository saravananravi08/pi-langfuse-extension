import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMemoryDiskCache } from '../memory/memory-disk-cache.js';

const scope = { sessionId: 'session-a', piSessionId: 'pi-a', pathKey: '/project/a', branchLeafEntryId: 'leaf-a' };

function score(id, name = 'memory_trace_observation', extra = {}) {
  return { id, name, metadata: { version: 'v2', sessionId: scope.sessionId, pathKey: scope.pathKey, generatedAt: '2026-01-01T00:00:00Z', ...extra } };
}

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'memory-disk-cache-'));
  return { rootDir, cache: createMemoryDiskCache({ rootDir, host: 'https://cloud.langfuse.com/', projectKey: 'pk-test' }) };
}

test('persists session/path-scoped scores atomically with private permissions', async t => {
  const { rootDir, cache } = await fixture();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  assert.equal(await cache.save(scope, [score('observation')]), true);

  const path = cache.filePath(scope.sessionId, scope.pathKey);
  assert.match(path, /[a-f0-9]{16}\/session-a\.json$/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual((await cache.load(scope)).scores.map(item => item.id), ['observation']);
});

test('rejects corrupt, wrong-project, and wrong-scope cache files', async t => {
  const { rootDir, cache } = await fixture();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await cache.save(scope, [score('observation')]);
  const path = cache.filePath(scope.sessionId, scope.pathKey);

  const otherProject = createMemoryDiskCache({ rootDir, host: 'https://cloud.langfuse.com', projectKey: 'pk-other' });
  assert.equal(await otherProject.load(scope), undefined);
  assert.equal(await cache.load({ ...scope, pathKey: '/project/other' }), undefined);
  await writeFile(path, '{broken', { mode: 0o600 });
  assert.equal(await cache.load(scope), undefined);
});

test('merges write-through scores and prunes observations covered by a reflection', async t => {
  const { rootDir, cache } = await fixture();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await cache.save(scope, [score('covered'), score('fresh')]);
  await cache.merge(scope, [score('reflection', 'memory_session_reflection', {
    generation: 1,
    sourceObservationScoreIds: ['covered'],
  })]);

  const snapshot = await cache.load(scope);
  assert.deepEqual(snapshot.scores.map(item => item.id).sort(), ['fresh', 'reflection']);
  const payload = JSON.parse(await readFile(cache.filePath(scope.sessionId, scope.pathKey), 'utf8'));
  assert.equal(payload.piSessionId, 'pi-a');
  assert.equal(payload.branchLeafEntryId, 'leaf-a');
});
