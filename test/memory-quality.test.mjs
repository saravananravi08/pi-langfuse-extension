import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alignDurableItems,
  buildRecentUserRequests,
  buildSemanticCoverage,
  classifyMemoryQuery,
  prepareMetadataReplacement,
  reduceDurableItems,
  semanticCoverageComplete,
  textSupportsClaim,
  validateDurableItemAuthority,
} from '../memory/memory-quality.js';

function user(id, text, timestamp) {
  return { id, type: 'message', timestamp, message: { role: 'user', content: text } };
}

test('working memory keeps exact recent user requests and marks corrections', () => {
  const requests = buildRecentUserRequests([
    user('u1', 'old request', '2026-01-01T00:00:00Z'),
    user('u2', 'Do not refresh; we moved to direct DB querying instead', '2026-01-02T00:00:00Z'),
    user('u3', 'What did I ask?', '2026-01-03T00:00:00Z'),
  ]);
  assert.deepEqual(requests.map(item => item.entryId), ['u1', 'u2', 'u3']);
  assert.equal(requests[1].correction, true);
  assert.equal(requests[1].text, 'Do not refresh; we moved to direct DB querying instead');
});

test('classifies referential requests without semantic search terms', () => {
  assert.equal(classifyMemoryQuery('what is the question I asked?'), 'referential');
  assert.equal(classifyMemoryQuery('what remains?'), 'progress');
  assert.equal(classifyMemoryQuery('what did we decide?'), 'decision');
});

test('user decisions survive lower-authority assistant proposals', () => {
  const userDecision = {
    id: 'decision-refresh', kind: 'decision', topic: 'refresh', content: 'Do not refresh', status: 'active', authority: 'user',
    sourceEntryIds: ['u1'], sourceScoreIds: ['s1'], updatedAt: '2026-01-02T00:00:00Z',
  };
  const assistantProposal = {
    ...userDecision, content: 'Add weekly refresh', authority: 'assistant-proposal', status: 'proposed',
    sourceEntryIds: ['a2'], sourceScoreIds: ['s2'], updatedAt: '2026-01-03T00:00:00Z',
  };
  const reduced = reduceDurableItems([userDecision], [assistantProposal]);
  assert.equal(reduced.active[0].content, 'Do not refresh');
  assert.equal(reduced.conflicts.length, 1);
});

test('reflector can align a differently worded correction to an existing stable topic without changing authority', () => {
  const previous = {
    id: 'decision-analytics-refresh', kind: 'decision', topic: 'analytics refresh', content: 'Run weekly refresh', status: 'active', authority: 'user',
    sourceEntryIds: ['u1'], sourceScoreIds: ['s1'], updatedAt: '2026-01-01T00:00:00Z',
  };
  const correction = {
    kind: 'decision', topic: 'direct database querying', content: 'Do not refresh; query DB directly', status: 'active', authority: 'user',
    sourceEntryIds: ['u2'], sourceScoreIds: ['s2'], updatedAt: '2026-01-02T00:00:00Z',
  };
  const reflector = [{ ...correction, id: 'decision-analytics-refresh' }];
  const aligned = alignDurableItems([previous], [correction], reflector);
  const reduced = reduceDurableItems([previous], aligned);
  assert.equal(reduced.active[0].id, 'decision-analytics-refresh');
  assert.equal(reduced.active[0].content, 'Do not refresh; query DB directly');
  assert.equal(reduced.superseded[0].content, 'Run weekly refresh');
});

test('newer user correction supersedes older same-topic user decision', () => {
  const old = {
    id: 'decision-refresh', kind: 'decision', topic: 'refresh', content: 'Refresh weekly', status: 'active', authority: 'user',
    sourceEntryIds: ['u1'], sourceScoreIds: ['s1'], updatedAt: '2026-01-01T00:00:00Z',
  };
  const correction = { ...old, content: 'Query DB directly', sourceEntryIds: ['u2'], sourceScoreIds: ['s2'], updatedAt: '2026-01-02T00:00:00Z' };
  const reduced = reduceDurableItems([old], [correction]);
  assert.equal(reduced.active[0].content, 'Query DB directly');
  assert.equal(reduced.superseded[0].content, 'Refresh weekly');
});

test('user-authority claims must be entailed by exact user text', () => {
  const source = 'Do not refresh because we moved to direct DB querying; do the other fixes';
  assert.equal(textSupportsClaim(source, 'Skip refresh work; use direct DB querying'), true);
  assert.equal(textSupportsClaim(source, 'Set deployment passwords and configure HTTPS'), false);
});

test('authority must match exact Pi entry roles', () => {
  const item = { authority: 'user', sourceEntryIds: ['a1'] };
  assert.equal(validateDurableItemAuthority(item, { userEntryIds: ['u1'], assistantEntryIds: ['a1'] }), false);
  assert.equal(validateDurableItemAuthority({ ...item, sourceEntryIds: ['u1'] }, { userEntryIds: ['u1'] }), true);
});

test('forced score replacement clears stale nested Langfuse metadata array tails', () => {
  const previous = { durableItems: [{ sourceEntryIds: ['u1', 'stale'] }, { id: 'stale-item' }], constraints: ['current', 'stale'] };
  const next = { durableItems: [{ sourceEntryIds: ['u1'] }], constraints: ['current'] };
  assert.deepEqual(prepareMetadataReplacement(next, previous), {
    durableItems: [{ sourceEntryIds: ['u1', ''] }, null],
    constraints: ['current', ''],
  });
});

test('semantic eligibility requires complete mapped requests, questions, and corrections', () => {
  const value = buildSemanticCoverage({
    userRequests: [{ entryId: 'u1', status: 'answered' }],
    questionsAnswered: [{ questionEntryId: 'u1' }],
    corrections: [{ sourceEntryId: 'u1' }],
    provenance: { complete: true, entryIds: ['u1', 'a1'] },
  });
  assert.equal(value.replacementEligible, true);
  assert.equal(semanticCoverageComplete({ memoryStatus: 'ready', ...value }), true);

  const missing = buildSemanticCoverage({
    userRequests: [{ entryId: 'outside' }],
    provenance: { complete: true, entryIds: ['u1'] },
  });
  assert.equal(missing.replacementEligible, false);
});
