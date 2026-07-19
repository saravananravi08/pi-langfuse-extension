import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildActiveMemory,
  estimateTokens,
  latestReflection,
  reflectionThresholdMet,
} from '../memory-state.js';

function score(id, sessionId, pathKey, generatedAt, extra = {}) {
  return {
    id,
    traceId: `trace-${id}`,
    metadata: {
      version: 'v1',
      sessionId,
      pathKey,
      generatedAt,
      observationsMarkdown: `observation ${id}`,
      summary: `summary ${id}`,
      goal: [],
      constraints: [],
      currentTask: '',
      taskStatus: 'active',
      completed: [],
      inProgress: [],
      openIssues: [],
      decisions: [],
      nextSteps: [],
      criticalContext: [],
      filesRead: [],
      filesModified: [],
      filesCreated: [],
      filesDeleted: [],
      filesTouched: [],
      toolsUsed: [],
      ...extra,
    },
  };
}

function reflection(id, generation, generatedAt, coveredUntil, extra = {}) {
  return score(id, 'session-a', '/project-a', generatedAt, {
    generation,
    coveredUntil,
    reflectionMarkdown: `reflection ${id}`,
    ...extra,
  });
}

test('latest reflection uses generation, then generatedAt', () => {
  const selected = latestReflection([
    reflection('g1', 1, '2026-01-03T00:00:00Z', '2026-01-01T00:00:00Z'),
    reflection('g2-old', 2, '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'),
    reflection('g2-new', 2, '2026-01-04T00:00:00Z', '2026-01-01T00:00:00Z'),
  ]);
  assert.equal(selected.id, 'g2-new');
});

test('coveredUntil is exclusive and observations remain ordered without duplicates', () => {
  const boundary = score('boundary', 'session-a', '/project-a', '2026-01-02T00:00:00Z');
  const newer = score('newer', 'session-a', '/project-a', '2026-01-03T00:00:00Z');
  const latest = reflection('reflection', 1, '2026-01-04T00:00:00Z', '2026-01-02T00:00:00Z');
  const memory = buildActiveMemory([newer, boundary, newer], [latest], 'session-a', '/project-a');

  assert.equal(memory.latestReflection.id, 'reflection');
  assert.deepEqual(memory.newObservations.map(item => item.id), ['newer']);
});

test('session, path, and version scopes cannot leak', () => {
  const wanted = score('wanted', 'session-a', '/project-a', '2026-01-03T00:00:00Z');
  const observations = [
    wanted,
    score('other-session', 'session-b', '/project-a', '2026-01-04T00:00:00Z'),
    score('other-path', 'session-a', '/project-b', '2026-01-05T00:00:00Z'),
    score('other-version', 'session-a', '/project-a', '2026-01-06T00:00:00Z', { version: 'v2' }),
  ];
  const memory = buildActiveMemory(observations, [], 'session-a', '/project-a');
  assert.deepEqual(memory.newObservations.map(item => item.id), ['wanted']);
});

test('token accounting includes structured fields, not only markdown', () => {
  const observation = score('structured', 'session-a', '/project-a', '2026-01-03T00:00:00Z', {
    observationsMarkdown: 'short',
    completed: ['x'.repeat(8000)],
    criticalContext: ['y'.repeat(4000)],
  });
  const memory = buildActiveMemory([observation], [], 'session-a', '/project-a');

  assert.ok(memory.newObservationTokens > estimateTokens('short') + 2500);
  assert.ok(memory.activeTokens >= memory.newObservationTokens);
});

test('reflection requires all three thresholds and at least one observation', () => {
  const base = { newObservations: [{}], activeTokens: 20_000, newObservationTokens: 8_000 };
  const thresholds = { activeTokens: 20_000, newObservationTokens: 8_000, newObservations: 1 };

  assert.equal(reflectionThresholdMet(base, thresholds), true);
  assert.equal(reflectionThresholdMet({ ...base, activeTokens: 19_999 }, thresholds), false);
  assert.equal(reflectionThresholdMet({ ...base, newObservationTokens: 7_999 }, thresholds), false);
  assert.equal(reflectionThresholdMet({ ...base, newObservations: [] }, thresholds), false);
  assert.equal(reflectionThresholdMet(base, { ...thresholds, newObservations: 2 }), false);
});

test('no uncovered observations reports zero new-observation tokens', () => {
  const observation = score('covered', 'session-a', '/project-a', '2026-01-02T00:00:00Z');
  const latest = reflection('reflection', 1, '2026-01-03T00:00:00Z', '2026-01-02T00:00:00Z');
  const memory = buildActiveMemory([observation], [latest], 'session-a', '/project-a');

  assert.deepEqual(memory.newObservations, []);
  assert.equal(memory.newObservationTokens, 0);
});
