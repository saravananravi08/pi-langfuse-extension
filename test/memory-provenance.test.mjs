import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregatePiReflectionProvenance, buildPiTraceProvenance, findPiTraceStartEntryId } from '../memory-provenance.js';

const entry = (id, parentId, role, content, extra = {}) => ({
  type: 'message', id, parentId, timestamp: `2026-01-01T00:00:0${id.length}Z`,
  message: { role, content, ...extra },
});

test('finds the first user entry appended after the pre-turn parent', () => {
  const entries = [
    entry('old-user', null, 'user', 'old'),
    entry('old-answer', 'old-user', 'assistant', [{ type: 'text', text: 'old answer' }]),
    { type: 'custom', id: 'state', parentId: 'old-answer', data: {} },
    entry('new-user', 'state', 'user', 'new'),
    entry('new-answer', 'new-user', 'assistant', [{ type: 'text', text: 'new answer' }]),
  ];
  assert.equal(findPiTraceStartEntryId(entries, 'old-answer'), 'new-user');
  assert.equal(findPiTraceStartEntryId(entries, ''), 'old-user');
  assert.equal(findPiTraceStartEntryId(entries, 'missing'), '');
});

test('captures exact branch range and complete parallel tool pairs', () => {
  const entries = [
    entry('old', null, 'user', 'old'),
    entry('u1', 'old', 'user', 'current'),
    {
      type: 'thinking_level_change', id: 'setting', parentId: 'u1', timestamp: '2026-01-01T00:00:01Z', thinkingLevel: 'high',
    },
    entry('a1', 'setting', 'assistant', [
      { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} },
      { type: 'toolCall', id: 'call-2', name: 'bash', arguments: {} },
    ]),
    entry('r1', 'a1', 'toolResult', [{ type: 'text', text: 'one' }], { toolCallId: 'call-1', toolName: 'read' }),
    entry('r2', 'r1', 'toolResult', [{ type: 'text', text: 'two' }], { toolCallId: 'call-2', toolName: 'bash' }),
    entry('a2', 'r2', 'assistant', [{ type: 'text', text: 'done' }]),
  ];

  const result = buildPiTraceProvenance(entries, 'u1', 'pi-session');
  assert.deepEqual(result.errors, []);
  assert.equal(result.provenance.complete, true);
  assert.equal(result.provenance.firstEntryId, 'u1');
  assert.equal(result.provenance.lastEntryId, 'a2');
  assert.deepEqual(result.provenance.entryIds, ['u1', 'setting', 'a1', 'r1', 'r2', 'a2']);
  assert.deepEqual(result.provenance.messageEntryIds, ['u1', 'a1', 'r1', 'r2', 'a2']);
  assert.deepEqual(result.provenance.toolPairs, [
    { toolCallId: 'call-1', toolName: 'read', assistantEntryId: 'a1', toolResultEntryId: 'r1' },
    { toolCallId: 'call-2', toolName: 'bash', assistantEntryId: 'a1', toolResultEntryId: 'r2' },
  ]);
});

test('reports missing boundaries and incomplete tool pairs', () => {
  assert.deepEqual(buildPiTraceProvenance([], '', 'session').errors, ['start entry id is missing']);
  assert.deepEqual(buildPiTraceProvenance([], 'missing', 'session').errors, ['start entry is not on current branch']);

  const entries = [
    entry('u1', null, 'user', 'current'),
    entry('a1', 'u1', 'assistant', [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }]),
    entry('r2', 'a1', 'toolResult', [{ type: 'text', text: 'orphan' }], { toolCallId: 'call-2', toolName: 'bash' }),
  ];
  const result = buildPiTraceProvenance(entries, 'u1', 'session');
  assert.equal(result.provenance.complete, false);
  assert.deepEqual(result.provenance.missingToolResultIds, ['call-1']);
  assert.deepEqual(result.provenance.orphanToolResultIds, ['call-2']);
  assert.match(result.errors.join('; '), /no result entry/);
  assert.match(result.errors.join('; '), /no assistant call entry/);
});

test('aggregates reflection ranges and preserves incomplete historical coverage', () => {
  const provenance = {
    version: 'pi-entry-v1', piSessionId: 'pi-session', complete: true,
    firstEntryId: 'u2', lastEntryId: 'a2', entryIds: ['u2', 'a2'],
    toolPairs: [{ toolCallId: 'call', assistantEntryId: 'a2', toolResultEntryId: 'r2' }],
  };
  const result = aggregatePiReflectionProvenance({
    piProvenanceComplete: false,
    sourcePiEntryIds: ['u1', 'a1'],
    sourcePiRanges: [{ observationScoreId: 'old', firstEntryId: 'u1', lastEntryId: 'a1', entryIds: ['u1', 'a1'] }],
  }, [{ id: 'new', traceId: 'trace-new', metadata: { piProvenance: provenance } }]);

  assert.equal(result.piProvenanceComplete, false);
  assert.deepEqual(result.sourcePiSessionIds, ['pi-session']);
  assert.deepEqual(result.sourcePiEntryIds, ['u1', 'a1', 'u2', 'a2']);
  assert.equal(result.sourcePiRanges.at(-1).observationScoreId, 'new');
  assert.equal(result.sourcePiToolPairs[0].traceId, 'trace-new');
  assert.equal(result.coveredThroughPiEntryId, 'a2');
});

test('rejects a non-user range boundary', () => {
  const entries = [entry('a1', null, 'assistant', [{ type: 'text', text: 'answer' }])];
  const result = buildPiTraceProvenance(entries, 'a1', 'session');
  assert.equal(result.provenance.complete, false);
  assert.deepEqual(result.errors, ['range does not start with a user message']);
});
