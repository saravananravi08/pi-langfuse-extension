import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeObservationV2, normalizeScoreV3, sessionObservationBounds, traceFromRootObservation } from '../memory/langfuse-v4-api.js';

test('normalizes v4 observation IO and reconstructs a trace from its root', () => {
  const root = {
    id: 'root', traceId: 'trace-a', startTime: '2026-08-18T00:00:00Z', name: 'root-span', traceName: 'pi-agent',
    sessionId: 'session-a', input: '{"prompt":"hello"}', output: 'plain text', metadata: { cwd: '/project' },
  };
  assert.deepEqual(normalizeObservationV2(root).input, { prompt: 'hello' });
  assert.deepEqual(traceFromRootObservation(root), {
    id: 'trace-a', timestamp: '2026-08-18T00:00:00Z', name: 'pi-agent', input: { prompt: 'hello' }, output: 'plain text',
    sessionId: 'session-a', metadata: { cwd: '/project' }, environment: undefined, release: undefined, tags: [],
  });
});

test('flattens v3 score subjects for existing memory consumers', () => {
  assert.equal(normalizeScoreV3({ id: 'score', subject: { kind: 'trace', id: 'trace-a' }, metadata: {} }).traceId, 'trace-a');
  assert.deepEqual(normalizeScoreV3({ id: 'score', subject: { kind: 'observation', id: 'obs-a', traceId: 'trace-a' }, metadata: {} }), {
    id: 'score', subject: { kind: 'observation', id: 'obs-a', traceId: 'trace-a' }, metadata: {}, traceId: 'trace-a', observationId: 'obs-a', sessionId: null,
  });
});

test('derives bounded observation dates from Pi session IDs', () => {
  const bounds = sessionObservationBounds('2026-07-23T11-25-14-911Z_019f8eb8', Date.parse('2026-08-18T00:00:00Z'));
  assert.equal(bounds.fromStartTime, '2026-07-22T11:25:14.911Z');
  assert.equal(bounds.toStartTime, '2026-08-19T00:00:00.000Z');
});
