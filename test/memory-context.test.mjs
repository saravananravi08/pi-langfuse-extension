import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMemoryContextCoverage,
  buildMemoryContextText,
  formatMemoryContextPreview,
  formatMemoryContextStatus,
  planMemoryContextReplacement,
} from '../memory/memory-context.js';

function entry(id, parentId, message) {
  return { type: 'message', id, parentId, timestamp: new Date(message.timestamp).toISOString(), message };
}

function observation(id, provenance) {
  return { id, traceId: `trace-${id}`, metadata: { piProvenance: provenance } };
}

const user1 = { role: 'user', content: 'old user', timestamp: 1 };
const call1 = { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }], timestamp: 2 };
const result1 = { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: 'result' }], timestamp: 3 };
const answer1 = { role: 'assistant', content: [{ type: 'text', text: 'old answer' }], timestamp: 4 };
const user2 = { role: 'user', content: 'current user', timestamp: 5 };
const branch = [
  entry('u1', null, user1),
  entry('a1', 'u1', call1),
  entry('r1', 'a1', result1),
  entry('a2', 'r1', answer1),
  entry('u2', 'a2', user2),
];
const provenance = {
  version: 'pi-entry-v1', piSessionId: 'pi-session', complete: true,
  firstEntryId: 'u1', lastEntryId: 'a2', entryIds: ['u1', 'a1', 'r1', 'a2'],
  toolPairs: [{ toolCallId: 'call-1', assistantEntryId: 'a1', toolResultEntryId: 'r1' }],
};

test('builds bounded untrusted memory with provenance and newest observations', () => {
  const text = buildMemoryContextText({
    reflection: { scoreId: 'reflection-1', fields: { summary: 'checkpoint', apiKey: 'example-credential' } },
    observations: [
      { scoreId: 'old', fields: { summary: 'old detail' } },
      { scoreId: 'new', fields: { summary: 'new detail' } },
    ],
  }, 20_000);

  assert.match(text, /UNTRUSTED HISTORICAL DATA/);
  assert.match(text, /reflection-1/);
  assert.ok(text.indexOf('"new"') < text.indexOf('"old"'));
  assert.doesNotMatch(text, /example-credential/);
  assert.match(text, /\[REDACTED\]/);
});

test('drops only exactly covered entries and preserves current turn and complete tool pairs', () => {
  const coverage = buildMemoryContextCoverage(undefined, [observation('score-1', provenance)], 'pi-session');
  const plan = planMemoryContextReplacement([user1, call1, result1, answer1, user2], branch, 'memory', coverage, 123);

  assert.equal(plan.safe, true);
  assert.deepEqual(plan.droppedEntryIds, ['u1', 'a1', 'r1', 'a2']);
  assert.deepEqual(plan.retainedEntryIds, ['u2']);
  assert.equal(plan.messages[0].customType, 'langfuse-memory-context');
  assert.deepEqual(plan.messages.slice(1), [user2]);
  assert.equal(plan.toolPairs[0].toolCallId, 'call-1');
});

test('blocks incomplete, overlapping, mismatched-session, and non-contiguous provenance', () => {
  const incomplete = buildMemoryContextCoverage(undefined, [observation('bad', { ...provenance, complete: false })], 'pi-session');
  assert.equal(incomplete.safe, false);

  const overlap = buildMemoryContextCoverage(undefined, [
    observation('one', provenance),
    observation('two', { ...provenance, firstEntryId: 'a2', entryIds: ['a2'], toolPairs: [] }),
  ], 'pi-session');
  assert.equal(overlap.safe, false);
  assert.deepEqual(overlap.overlappingEntryIds, ['a2']);

  const mismatch = buildMemoryContextCoverage(undefined, [observation('one', provenance)], 'other-session');
  assert.equal(mismatch.safe, false);

  const coverage = buildMemoryContextCoverage(undefined, [observation('one', { ...provenance, entryIds: ['u1', 'r1', 'a2'] })], 'pi-session');
  const plan = planMemoryContextReplacement([user1, call1, result1, answer1, user2], branch, 'memory', coverage);
  assert.equal(plan.safe, false);
  assert.match(plan.reasons.join('\n'), /not contiguous/);
});

test('retains a trailing current user before its Pi entry becomes visible', () => {
  const coverage = buildMemoryContextCoverage(undefined, [observation('score-1', provenance)], 'pi-session');
  const plan = planMemoryContextReplacement([user1, call1, result1, answer1, user2], branch.slice(0, 4), 'memory', coverage);
  assert.equal(plan.safe, true);
  assert.deepEqual(plan.retainedUnmappedTailIndexes, [4]);
  assert.deepEqual(plan.messages.slice(1), [user2]);
});

test('retains trailing parallel tool results while Pi session entries catch up', () => {
  const call2 = { role: 'assistant', content: [{ type: 'toolCall', id: 'call-2', name: 'bash', arguments: {} }], timestamp: 6 };
  const result2 = { role: 'toolResult', toolCallId: 'call-2', content: [{ type: 'text', text: 'late result' }], timestamp: 7 };
  const currentBranch = [...branch, entry('a3', 'u2', call2)];
  const coverage = buildMemoryContextCoverage(undefined, [observation('score-1', provenance)], 'pi-session');
  const plan = planMemoryContextReplacement([user1, call1, result1, answer1, user2, call2, result2], currentBranch, 'memory', coverage);
  assert.equal(plan.safe, true);
  assert.deepEqual(plan.retainedUnmappedTailIndexes, [6]);
  assert.deepEqual(plan.messages.slice(1), [user2, call2, result2]);
});

test('does not require a result for a tool call from an errored assistant response', () => {
  const errored = { role: 'assistant', content: [{ type: 'toolCall', id: 'never-ran', name: 'bash', arguments: {} }], stopReason: 'error', timestamp: 6 };
  const currentBranch = [...branch, entry('a3', 'u2', errored)];
  const coverage = buildMemoryContextCoverage(undefined, [observation('score-1', provenance)], 'pi-session');
  const plan = planMemoryContextReplacement([user1, call1, result1, answer1, user2, errored], currentBranch, 'memory', coverage);
  assert.equal(plan.safe, true);
  assert.deepEqual(plan.messages.slice(1), [user2, errored]);
});

test('accepts stale merged missing-pair metadata when the call is proven unexecuted', () => {
  const user = { role: 'user', content: 'run', timestamp: 10 };
  const errored = { role: 'assistant', content: [{ type: 'toolCall', id: 'never-ran', name: 'bash', arguments: {} }], stopReason: 'error', timestamp: 11 };
  const entries = [entry('u10', null, user), entry('a10', 'u10', errored)];
  const stale = {
    version: 'pi-entry-v1', piSessionId: 'pi-session', complete: true,
    firstEntryId: 'u10', lastEntryId: 'a10', entryIds: ['u10', 'a10'],
    toolPairs: [{ toolCallId: 'never-ran', assistantEntryId: 'a10', toolResultEntryId: null }],
    missingToolResultIds: ['never-ran'], unexecutedToolCallIds: ['never-ran'],
  };
  const coverage = buildMemoryContextCoverage(undefined, [observation('stale', stale)], 'pi-session');
  const plan = planMemoryContextReplacement([user, errored], entries, 'memory', coverage);
  assert.equal(plan.safe, true);
  assert.deepEqual(coverage.toolPairs, []);
});

test('blocks replacement that cannot map an older model message or would split a tool pair', () => {
  const coverage = buildMemoryContextCoverage(undefined, [observation('score-1', provenance)], 'pi-session');
  const changedUser = { ...user1, content: 'changed older message' };
  const unmapped = planMemoryContextReplacement([changedUser, call1, result1, answer1, user2], branch, 'memory', coverage);
  assert.equal(unmapped.safe, false);
  assert.match(unmapped.reasons.join('\n'), /cannot be mapped/);

  const splitCoverage = { ...coverage, entryIds: ['u1', 'a1'], ranges: [{ observationScoreId: 'x', firstEntryId: 'u1', lastEntryId: 'a1', entryIds: ['u1', 'a1'] }] };
  const split = planMemoryContextReplacement([user1, call1, result1, answer1, user2], branch, 'memory', splitCoverage);
  assert.equal(split.safe, false);
  assert.match(split.reasons.join('\n'), /split tool pair/);
});

test('formats actual provider usage separately from replacement-message estimate', () => {
  assert.equal(
    formatMemoryContextStatus({ actualInputTokens: 67_728, contextWindow: 272_000, replacementTokensEstimated: 7_128, droppedEntryCount: 40, retainedEntryCount: 5 }),
    'Memory 24.9%/272k · est 7.1k',
  );
  assert.equal(formatMemoryContextStatus({ replacementTokensEstimated: 7_128 }), 'Memory ON · awaiting usage · est 7.1k');
});

test('preview exposes score, entry, tool-pair, and token decisions', () => {
  const coverage = buildMemoryContextCoverage(undefined, [observation('score-1', provenance)], 'pi-session');
  const plan = planMemoryContextReplacement([user1, call1, result1, answer1, user2], branch, 'memory', coverage);
  const preview = JSON.parse(formatMemoryContextPreview(plan));
  assert.equal(preview.safe, true);
  assert.deepEqual(preview.scoreIds, ['score-1']);
  assert.equal(preview.droppedEntryCount, 4);
  assert.equal(preview.retainedEntryCount, 1);
  assert.equal(preview.toolPairCount, 1);
  assert.ok(preview.tokens.replacement > 0);
});
