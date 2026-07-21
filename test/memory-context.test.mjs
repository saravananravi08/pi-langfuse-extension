import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMemoryContextCoverage,
  buildMemoryContextText,
  filterMemoryScoresForBranch,
  formatMemoryContextPreview,
  formatMemoryContextStatus,
  planMemoryContextReplacement,
} from '../memory/memory-context.js';

function entry(id, parentId, message) {
  return { type: 'message', id, parentId, timestamp: new Date(message.timestamp).toISOString(), message };
}

function observation(id, provenance) {
  return {
    id,
    traceId: `trace-${id}`,
    metadata: {
      piProvenance: provenance,
      memoryStatus: 'ready',
      replacementEligible: true,
      semanticCoverage: { userRequests: 1, preservedUserRequests: 1, corrections: 0, preservedCorrections: 0, questions: 0, preservedQuestions: 0 },
    },
  };
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
});

test('includes compatible legacy details without granting replacement authority', () => {
  const text = buildMemoryContextText({
    reflection: { scoreId: 'v2', fields: { summary: 'current state' } },
    legacyReflection: { scoreId: 'v1', generation: 5, fields: { summary: 'older project detail', decisions: ['legacy decision'] } },
    observations: [],
  });
  assert.match(text, /Compatible Legacy Project Details/);
  assert.match(text, /older project detail/);
  assert.match(text, /lower-priority historical context/i);
});

test('excludes abandoned sibling-branch memory but keeps partial mappings fail-closed', () => {
  const sibling = observation('sibling', {
    ...provenance, firstEntryId: 'sibling-user', lastEntryId: 'sibling-answer',
    entryIds: ['sibling-user', 'sibling-answer'], toolPairs: [],
  });
  const partial = observation('partial', {
    ...provenance, firstEntryId: 'u1', lastEntryId: 'sibling-answer',
    entryIds: ['u1', 'sibling-answer'], toolPairs: [],
  });
  const compatibleReflection = { id: 'reflection-current', metadata: { sourcePiRanges: [{ entryIds: ['u1', 'a1'] }] } };
  const siblingReflection = { id: 'reflection-sibling', metadata: { sourcePiRanges: [{ entryIds: ['sibling-user', 'sibling-answer'] }] } };
  const filtered = filterMemoryScoresForBranch(
    [observation('current', provenance), sibling, partial, compatibleReflection, siblingReflection],
    branch,
  );
  assert.deepEqual(filtered.map(score => score.id), ['current', 'partial', 'reflection-current']);
});

test('uses complete legacy provenance for compatibility without overlapping v2 ranges', () => {
  const legacy = {
    id: 'legacy-reflection',
    metadata: {
      piProvenanceComplete: true,
      sourcePiRanges: [{ observationScoreId: 'legacy-observation', ...provenance }],
      sourcePiSessionIds: ['pi-session'],
      sourcePiToolPairs: provenance.toolPairs,
    },
  };
  const legacyOnly = buildMemoryContextCoverage(undefined, [], 'pi-session', legacy);
  assert.equal(legacyOnly.safe, true);
  assert.deepEqual(legacyOnly.compatibilityScoreIds, ['legacy-reflection']);
  assert.deepEqual(legacyOnly.entryIds, provenance.entryIds);

  const legacyTail = observation('legacy-tail', {
    ...provenance,
    firstEntryId: 'u3',
    lastEntryId: 'a3',
    entryIds: ['u3', 'a3'],
    messageEntryIds: ['u3', 'a3'],
    toolPairs: [],
  });
  const withTail = buildMemoryContextCoverage(undefined, [], 'pi-session', legacy, [legacyTail]);
  assert.equal(withTail.safe, true);
  assert.deepEqual(withTail.compatibilityScoreIds, ['legacy-reflection', 'legacy-tail']);

  const v2Preferred = buildMemoryContextCoverage(undefined, [observation('score-1', provenance)], 'pi-session', legacy);
  assert.equal(v2Preferred.safe, true);
  assert.deepEqual(v2Preferred.compatibilityScoreIds, []);
  assert.equal(v2Preferred.overlappingEntryIds.length, 0);
});

test('drops only exactly covered entries and preserves current turn and complete tool pairs', () => {
  const coverage = buildMemoryContextCoverage(undefined, [observation('score-1', provenance)], 'pi-session');
  const plan = planMemoryContextReplacement([user1, call1, result1, answer1, user2], branch, 'memory', coverage, 123);

  assert.equal(plan.safe, true);
  assert.deepEqual(plan.droppedEntryIds, []);
  assert.deepEqual(plan.retainedEntryIds, ['u1', 'a1', 'r1', 'a2', 'u2']);
  assert.equal(plan.messages[0].customType, 'langfuse-memory-context');
  assert.deepEqual(plan.messages.slice(1), [user1, call1, result1, answer1, user2]);
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
  const plan = planMemoryContextReplacement([user1, call1, result1, answer1, user2], branch.slice(0, 4), 'memory', coverage, undefined, { recentTurnCount: 1 });
  assert.equal(plan.safe, true);
  assert.deepEqual(plan.retainedUnmappedTailIndexes, [4]);
  assert.deepEqual(plan.messages.slice(1), [user2]);
});

test('retains trailing parallel tool results while Pi session entries catch up', () => {
  const call2 = { role: 'assistant', content: [{ type: 'toolCall', id: 'call-2', name: 'bash', arguments: {} }], timestamp: 6 };
  const result2 = { role: 'toolResult', toolCallId: 'call-2', content: [{ type: 'text', text: 'late result' }], timestamp: 7 };
  const currentBranch = [...branch, entry('a3', 'u2', call2)];
  const coverage = buildMemoryContextCoverage(undefined, [observation('score-1', provenance)], 'pi-session');
  const plan = planMemoryContextReplacement([user1, call1, result1, answer1, user2, call2, result2], currentBranch, 'memory', coverage, undefined, { recentTurnCount: 1 });
  assert.equal(plan.safe, true);
  assert.deepEqual(plan.retainedUnmappedTailIndexes, [6]);
  assert.deepEqual(plan.messages.slice(1), [user2, call2, result2]);
});

test('excludes binary image data from token estimates and reports images separately', () => {
  const imageCall = { role: 'assistant', content: [{ type: 'toolCall', id: 'call-image', name: 'read', arguments: {} }], timestamp: 6 };
  const imageResult = {
    role: 'toolResult', toolCallId: 'call-image', toolName: 'read', timestamp: 7,
    content: [{ type: 'text', text: 'image' }, { type: 'image', data: 'a'.repeat(400_000), mimeType: 'image/png' }],
  };
  const currentBranch = [...branch, entry('a3', 'u2', imageCall), entry('r2', 'a3', imageResult)];
  const coverage = buildMemoryContextCoverage(undefined, [observation('score-1', provenance)], 'pi-session');
  const plan = planMemoryContextReplacement([user1, call1, result1, answer1, user2, imageCall, imageResult], currentBranch, 'memory', coverage);
  assert.equal(plan.safe, true);
  assert.equal(plan.originalImageCount, 1);
  assert.equal(plan.retainedImageCount, 1);
  assert.equal(plan.replacementImageCount, 1);
  assert.ok(plan.replacementTokensEstimated < 1_000);
});

test('does not require a result for a tool call from an errored assistant response', () => {
  const errored = { role: 'assistant', content: [{ type: 'toolCall', id: 'never-ran', name: 'bash', arguments: {} }], stopReason: 'error', timestamp: 6 };
  const currentBranch = [...branch, entry('a3', 'u2', errored)];
  const coverage = buildMemoryContextCoverage(undefined, [observation('score-1', provenance)], 'pi-session');
  const plan = planMemoryContextReplacement([user1, call1, result1, answer1, user2, errored], currentBranch, 'memory', coverage, undefined, { recentTurnCount: 1 });
  assert.equal(plan.safe, true);
  assert.deepEqual(plan.messages.slice(1), [user2, errored]);
});

test('retains a visible pending tool-call turn without disabling replacement', () => {
  const pendingUser = { role: 'user', content: 'start pending work', timestamp: 10 };
  const pendingCall = { role: 'assistant', content: [{ type: 'toolCall', id: 'still-running', name: 'bash', arguments: {} }], stopReason: 'toolUse', timestamp: 11 };
  const currentUser = { role: 'user', content: 'check memory', timestamp: 12 };
  const entries = [entry('u10', null, pendingUser), entry('a10', 'u10', pendingCall), entry('u11', 'a10', currentUser)];
  const coverage = {
    safe: true, reasons: [], entryIds: ['u10', 'a10'],
    ranges: [{ observationScoreId: 'pending', firstEntryId: 'u10', lastEntryId: 'a10', entryIds: ['u10', 'a10'] }],
  };
  const plan = planMemoryContextReplacement([pendingUser, pendingCall, currentUser], entries, 'memory', coverage, undefined, { recentTurnCount: 1 });
  assert.equal(plan.safe, true);
  assert.deepEqual(plan.messages.slice(1), [pendingUser, pendingCall, currentUser]);
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
  const split = planMemoryContextReplacement([user1, call1, result1, answer1, user2], branch, 'memory', splitCoverage, undefined, { recentTurnCount: 1 });
  assert.equal(split.safe, false);
  assert.match(split.reasons.join('\n'), /split tool pair/);
});

test('formats actual provider usage separately from replacement-message estimate', () => {
  assert.equal(
    formatMemoryContextStatus({ actualInputTokens: 67_728, contextWindow: 272_000, replacementTokensEstimated: 7_128, droppedEntryCount: 40, retainedEntryCount: 5 }),
    'Memory 24.9%/272k · est 7.1k',
  );
  assert.equal(formatMemoryContextStatus({ replacementTokensEstimated: 7_128 }), 'Memory ON · awaiting usage · est 7.1k');
  assert.equal(
    formatMemoryContextStatus({ actualInputTokens: 67_728, contextWindow: 272_000, replacementTokensEstimated: 7_128, replacementImageCount: 3 }),
    'Memory 24.9%/272k · est 7.1k + 3 images',
  );
  assert.equal(
    formatMemoryContextStatus({ actualInputTokens: 67_728, contextWindow: 272_000, replacementTokensEstimated: 7_128, modelCost: 1.23456 }),
    'Memory 24.9%/272k · est 7.1k · $1.235',
  );
  assert.equal(
    formatMemoryContextStatus({ actualInputTokens: 67_728, contextWindow: 272_000, replacementTokensEstimated: 7_128, modelCost: 0, modelCostSubscription: true }),
    'Memory 24.9%/272k · est 7.1k · $0.000 (sub)',
  );
});

test('preview exposes score, entry, tool-pair, and token decisions', () => {
  const coverage = buildMemoryContextCoverage(undefined, [observation('score-1', provenance)], 'pi-session');
  const plan = planMemoryContextReplacement([user1, call1, result1, answer1, user2], branch, 'memory', coverage);
  const preview = JSON.parse(formatMemoryContextPreview(plan));
  assert.equal(preview.safe, true);
  assert.deepEqual(preview.scoreIds, ['score-1']);
  assert.equal(preview.droppedEntryCount, 0);
  assert.equal(preview.retainedEntryCount, 5);
  assert.equal(preview.recentRetainedEntryCount, 5);
  assert.equal(preview.toolPairCount, 1);
  assert.ok(preview.tokens.replacement > 0);
  assert.equal(preview.images.replacement, 0);
});

test('shrinks injected memory to fit remaining safe context budget', () => {
  const coverage = buildMemoryContextCoverage(undefined, [observation('score-1', provenance)], 'pi-session');
  const plan = planMemoryContextReplacement(
    [user1, call1, result1, answer1, user2],
    branch,
    `important memory\n${'detail '.repeat(8_000)}`,
    coverage,
    undefined,
    { recentTurnCount: 1, maxReplacementTokens: 1_500 },
  );
  assert.equal(plan.safe, true);
  assert.equal(plan.memoryTruncated, true);
  assert.ok(plan.memoryTokensEstimated < plan.originalMemoryTokensEstimated);
  assert.ok(plan.replacementTokensEstimated <= 1_500);
});

test('does not bypass Pi compaction when replacement remains above safe context budget', () => {
  const coverage = buildMemoryContextCoverage(undefined, [observation('score-1', provenance)], 'pi-session');
  const plan = planMemoryContextReplacement([user1, call1, result1, answer1, user2], branch, 'memory', coverage, undefined, { maxReplacementTokens: 1 });
  assert.equal(plan.safe, false);
  assert.match(plan.reasons.join('\n'), /exceeds safe/);
  assert.deepEqual(plan.messages, [user1, call1, result1, answer1, user2]);
});

test('semantic coverage is mandatory even when Pi provenance is complete', () => {
  const lookupOnly = observation('lookup-only', provenance);
  lookupOnly.metadata.replacementEligible = false;
  const coverage = buildMemoryContextCoverage(undefined, [lookupOnly], 'pi-session');
  assert.equal(coverage.safe, false);
  assert.deepEqual(coverage.semanticCoverageFailures, ['lookup-only']);
  assert.deepEqual(coverage.lookupOnlyScoreIds, ['lookup-only']);
});

test('retains two recent turns but replaces an older covered turn', () => {
  const oldUser = { role: 'user', content: 'oldest user', timestamp: 0 };
  const oldAnswer = { role: 'assistant', content: [{ type: 'text', text: 'oldest answer' }], timestamp: 0.5 };
  const entries = [entry('u0', null, oldUser), entry('a0', 'u0', oldAnswer), ...branch.map(item => ({ ...item, parentId: item.parentId === null ? 'a0' : item.parentId }))];
  const oldProvenance = { version: 'pi-entry-v1', piSessionId: 'pi-session', complete: true, firstEntryId: 'u0', lastEntryId: 'a0', entryIds: ['u0', 'a0'], toolPairs: [] };
  const coverage = buildMemoryContextCoverage(undefined, [observation('old-score', oldProvenance)], 'pi-session');
  const plan = planMemoryContextReplacement([oldUser, oldAnswer, user1, call1, result1, answer1, user2], entries, 'memory', coverage);
  assert.equal(plan.safe, true);
  assert.deepEqual(plan.droppedEntryIds, ['u0', 'a0']);
  assert.ok(plan.recentRetainedEntryIds.includes('u1'));
  assert.ok(plan.recentRetainedEntryIds.includes('u2'));
});

test('referential context prioritizes exact recent user requests', () => {
  const text = buildMemoryContextText({
    currentPrompt: 'What question did I ask?',
    recentUserRequests: [{ entryId: 'e4ad2613', text: 'Check whether relevance, keywords and interests can fetch relevant profiles' }],
    observations: [{ scoreId: 'older', fields: { summary: 'Unrelated payload question' } }],
  });
  assert.match(text, /Query class: referential/);
  assert.match(text, /e4ad2613/);
  assert.match(text, /relevance, keywords and interests/);
  assert.ok(text.indexOf('Exact Recent User Requests') < text.indexOf('Relevant Retrieved Episodes'));
});
