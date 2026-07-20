import assert from 'node:assert/strict';
import test from 'node:test';
import { auditObservationCoverage, auditPiProvenance } from '../memory/memory-audit.js';

test('audits missing, incomplete, invalid, and overlapping Pi provenance', () => {
  const complete = {
    version: 'pi-entry-v1', complete: true,
    firstEntryId: 'u1', lastEntryId: 'a1', userEntryId: 'u1',
    entryIds: ['u1', 'a1'], messageEntryIds: ['u1', 'a1'], toolPairs: [],
    missingToolResultIds: [], orphanToolResultIds: [],
  };
  const report = auditPiProvenance([
    { id: 'complete', metadata: { piProvenance: complete } },
    { id: 'overlap', metadata: { piProvenance: { ...complete, firstEntryId: 'u2', entryIds: ['u2', 'a1'], userEntryId: 'u2', messageEntryIds: ['u2', 'a1'] } } },
    { id: 'incomplete', metadata: { piProvenance: { ...complete, complete: false, firstEntryId: 'u3', lastEntryId: 'a3', entryIds: ['u3', 'a3'], messageEntryIds: ['u3', 'a3'], userEntryId: 'u3', missingToolResultIds: ['call'] } } },
    { id: 'invalid', metadata: { piProvenance: { ...complete, firstEntryId: 'wrong', lastEntryId: 'a4', entryIds: ['u4', 'a4'], messageEntryIds: ['u4', 'a4'], userEntryId: 'u4' } } },
    { id: 'missing', metadata: {} },
  ]);
  assert.equal(report.scores, 5);
  assert.equal(report.complete, 2);
  assert.deepEqual(report.missingScoreIds, ['missing']);
  assert.deepEqual(report.incompleteScoreIds, ['incomplete']);
  assert.deepEqual(report.invalidScoreIds, ['invalid']);
  assert.deepEqual(report.overlappingEntryIds, ['a1']);
});

const options = {
  scoreName: 'memory_trace_observation',
  version: 'v1',
  expectedScoreId: traceId => `expected-${traceId}`,
};

function trace(id, completed = true, path = '/project', name = 'pi-agent', timestamp) {
  return { id, name, timestamp, metadata: { completed, cwd: path } };
}

function score(id, traceId, promptVersion = 'observer-v2', version = 'v1') {
  return { id, traceId, name: 'memory_trace_observation', metadata: { version, promptVersion, traceId } };
}

test('classifies observed, missing, and intentionally skipped traces', () => {
  const report = auditObservationCoverage([
    trace('observed'),
    trace('missing'),
    trace('incomplete', false),
    trace('other-name', true, '/project', 'other'),
  ], [score('expected-observed', 'observed')], options);

  assert.equal(report.traces, 4);
  assert.equal(report.observedTraces, 1);
  assert.deepEqual(report.eligibleMissingTraceIds, ['missing']);
  assert.deepEqual(report.intentionallySkippedTraceIds, ['incomplete', 'other-name']);
});

test('separates historical traces before observation coverage', () => {
  const report = auditObservationCoverage([
    trace('historical', true, '/project', 'pi-agent', '2026-01-01T00:00:00Z'),
    trace('observed', true, '/project', 'pi-agent', '2026-01-02T00:00:00Z'),
    trace('gap', true, '/project', 'pi-agent', '2026-01-03T00:00:00Z'),
  ], [score('expected-observed', 'observed')], options);

  assert.equal(report.coverageStart, '2026-01-02T00:00:00.000Z');
  assert.deepEqual(report.preCoverageTraceIds, ['historical']);
  assert.deepEqual(report.eligibleMissingTraceIds, ['gap']);
});

test('reports duplicates, prompt versions, and non-deterministic IDs', () => {
  const report = auditObservationCoverage([trace('a')], [
    score('expected-a', 'a'),
    score('unexpected', 'a', 'observer-v1'),
  ], options);

  assert.equal(report.observationScores, 2);
  assert.deepEqual(report.duplicateTraceIds, ['a']);
  assert.deepEqual(report.nonDeterministicScoreIds, ['unexpected']);
  assert.deepEqual(report.promptVersions, { 'observer-v2': 1, 'observer-v1': 1 });
});

test('isolates totals by cwd and ignores unrelated score versions', () => {
  const report = auditObservationCoverage([
    trace('a', true, '/a'),
    trace('b', true, '/b'),
  ], [
    score('expected-a', 'a'),
    score('old-b', 'b', 'observer-v1', 'v0'),
  ], options);

  assert.deepEqual(report.paths['/a'], { traces: 1, observed: 1, eligibleMissing: 0, preCoverage: 0, intentionallySkipped: 0 });
  assert.deepEqual(report.paths['/b'], { traces: 1, observed: 0, eligibleMissing: 1, preCoverage: 0, intentionallySkipped: 0 });
});
