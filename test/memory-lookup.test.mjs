import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMemoryResult, redactSecrets, searchMemoryScores } from '../memory-lookup.js';

function score(id, sessionId, pathKey, summary, extra = {}) {
  return {
    id,
    name: 'memory_trace_observation',
    traceId: `trace-${id}`,
    metadata: {
      version: 'v1',
      sessionId,
      pathKey,
      generatedAt: `2026-01-0${id.length}T00:00:00Z`,
      summary,
      goal: [], constraints: [], completed: [], inProgress: [], openIssues: [], decisions: [], nextSteps: [], criticalContext: [],
      ...extra,
    },
  };
}

test('defaults to combined session and path scope', () => {
  const scores = [
    score('a', 'session-a', '/a', 'wanted'),
    score('b', 'session-b', '/a', 'wanted'),
    score('c', 'session-a', '/b', 'wanted'),
  ];
  const results = searchMemoryScores(scores, { query: 'wanted', scope: 'session', sessionId: 'session-a', pathKey: '/a' });
  assert.deepEqual(results.map(result => result.score.id), ['a']);
});

test('supports path/all scopes and exact provenance filters', () => {
  const scores = [score('a', 'session-a', '/a', 'alpha'), score('b', 'session-b', '/a', 'beta')];
  assert.equal(searchMemoryScores(scores, { scope: 'path', pathKey: '/a', limit: 10 }).length, 2);
  assert.equal(searchMemoryScores(scores, { scope: 'all', scoreId: 'b' })[0].score.id, 'b');
  assert.equal(searchMemoryScores(scores, { scope: 'all', traceId: 'trace-a' })[0].score.id, 'a');
});

test('ranks exact phrase above token-only matches', () => {
  const scores = [score('a', 's', '/p', 'retry cache after failure'), score('bb', 's', '/p', 'retry unrelated text then later cache')];
  const results = searchMemoryScores(scores, { query: 'retry cache', scope: 'all' });
  assert.equal(results[0].score.id, 'a');
});

test('redacts nested credentials without hiding token metrics', () => {
  const redacted = redactSecrets({
    apiKey: 'example-credential-value',
    nested: { authorization: 'Bearer abcdefghijklmnop', outputTokens: 123 },
    text: 'password=hunter2 Bearer abcdefghijklmnop',
  });
  assert.deepEqual(redacted, {
    apiKey: '[REDACTED]',
    nested: { authorization: '[REDACTED]', outputTokens: 123 },
    text: 'password=[REDACTED] [REDACTED]',
  });
});

test('formats bounded memory with provenance and redaction', () => {
  const value = score('a', 'session-a', '/a', 'Authorization: Bearer abcdefghijklmnop', {
    promptVersion: 'observer-v2',
    observationsMarkdown: 'token=secretvalue path /repo/index.ts',
    filesModified: ['/repo/index.ts'],
  });
  const result = formatMemoryResult(value);
  assert.equal(result.scoreId, 'a');
  assert.equal(result.traceId, 'trace-a');
  assert.equal(result.promptVersion, 'observer-v2');
  assert.doesNotMatch(JSON.stringify(result), /secretvalue|abcdefghijklmnop/);
});
