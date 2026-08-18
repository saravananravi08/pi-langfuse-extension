import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateReflectionQuality, normalizeReflectionTaskStatus, renderReflectionMarkdown } from '../memory/memory-reflection.js';
import { REQUIRED_REFLECTION_HEADINGS } from '../memory/memory-prompts.js';

function fields(overrides = {}) {
  return {
    summary: 'Summary',
    goal: ['Ship reliable memory'],
    constraints: ['No data loss'],
    currentTask: 'Validate reflection',
    taskStatus: 'active',
    completed: ['Observer implemented'],
    inProgress: ['Reflection hardening'],
    openIssues: ['Exact recall pending'],
    decisions: ['Use append-only scores'],
    nextSteps: ['Add lookup tool'],
    criticalContext: ['Session scoped by path'],
    filesRead: ['/repo/README.md'],
    filesModified: ['/repo/index.ts'],
    filesCreated: ['/repo/test.js'],
    filesDeleted: [],
    toolsUsed: ['read', 'edit'],
    durableItems: [],
    ...overrides,
  };
}

test('renders stable checkpoint headings from canonical fields', () => {
  const value = fields();
  const first = renderReflectionMarkdown(value);
  const second = renderReflectionMarkdown(structuredClone(value));

  assert.equal(first, second);
  let previousIndex = -1;
  for (const heading of REQUIRED_REFLECTION_HEADINGS) {
    const index = first.indexOf(heading);
    assert.ok(index > previousIndex, `${heading} must appear in order`);
    previousIndex = index;
  }
  assert.match(first, /Current task: Validate reflection/);
  assert.match(first, /### Files Modified\n- \/repo\/index\.ts/);
});

test('bounds rendered historical file lists while canonical fields remain untouched', () => {
  const filesRead = Array.from({ length: 60 }, (_, index) => `/repo/file-${index}.ts`);
  const value = fields({ filesRead });
  const markdown = renderReflectionMarkdown(value);
  assert.doesNotMatch(markdown, /file-0\.ts/);
  assert.match(markdown, /file-59\.ts/);
  assert.equal(value.filesRead.length, 60);
});

test('bounds rendered durable provenance while canonical source IDs remain complete', () => {
  const sourceEntryIds = ['u1', 'u2', 'u3', 'u4', 'u5'];
  const durableItems = [{
    id: 'decision-1', kind: 'decision', topic: 'scope', content: 'Keep full provenance', status: 'active', authority: 'user', sourceEntryIds,
  }];
  const value = fields({ durableItems });
  const markdown = renderReflectionMarkdown(value);
  assert.doesNotMatch(markdown, /u1, u2/);
  assert.match(markdown, /u3, u4, u5 \(\+2 older\)/);
  assert.deepEqual(value.durableItems[0].sourceEntryIds, sourceEntryIds);
});

test('renders empty sections without inventing content', () => {
  const markdown = renderReflectionMarkdown(fields({ openIssues: [], filesDeleted: [] }));
  assert.match(markdown, /### Blocked\n\n## Key Decisions/);
  assert.match(markdown, /### Files Deleted\n### Tools Used/);
  assert.doesNotMatch(markdown, /None|N\/A/);
});

test('keeps rendered checkpoints within budget without mutating canonical fields', () => {
  const completed = Array.from({ length: 80 }, (_, index) => `Outcome ${index}: ${'verified detail '.repeat(20)}`);
  const value = fields({
    constraints: ['Preserve authoritative user state'],
    inProgress: ['Critical migration remains active'],
    openIssues: ['Deployment is blocked on credentials'],
    nextSteps: ['Obtain credentials before deployment'],
    completed,
  });
  const canonical = structuredClone(value);
  const markdown = renderReflectionMarkdown(value, { maxTokens: 1_000 });

  assert.ok(Math.ceil(markdown.length / 4) <= 1_000);
  assert.match(markdown, /Critical migration remains active/);
  assert.match(markdown, /Deployment is blocked on credentials/);
  assert.match(markdown, /older completed outcomes omitted/);
  assert.doesNotMatch(markdown, /Outcome 0:/);
  assert.deepEqual(value, canonical);
  for (const heading of REQUIRED_REFLECTION_HEADINGS) assert.match(markdown, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('normalizes contradictory complete status conservatively', () => {
  const value = fields({ taskStatus: 'complete', openIssues: ['Still blocked'] });
  const normalized = normalizeReflectionTaskStatus(value);
  assert.equal(normalized.taskStatus, 'active');
  assert.equal(value.taskStatus, 'complete');
  assert.equal(normalizeReflectionTaskStatus(fields({ taskStatus: 'complete', inProgress: [], openIssues: [] })).taskStatus, 'complete');
});

test('quality preserves durable source field categories', () => {
  const source = fields();
  const result = evaluateReflectionQuality(fields(), null, [source]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.metrics.fieldRetentionRatio, 1);
  assert.deepEqual(result.metrics.missingSourceFields, []);
});

test('quality permits unresolved work to become completed', () => {
  const source = fields({ completed: [], inProgress: ['Pending implementation'], openIssues: [], nextSteps: ['Implement'] });
  const output = fields({ completed: ['Implementation verified'], inProgress: [], openIssues: [], nextSteps: [], taskStatus: 'complete' });
  assert.deepEqual(evaluateReflectionQuality(output, null, [source]).errors, []);
});

test('quality rejects durable field loss and contradictions', () => {
  const source = fields();
  const missing = evaluateReflectionQuality(fields({ constraints: [] }), null, [source]);
  assert.match(missing.errors.join('; '), /constraints/);

  const contradictory = evaluateReflectionQuality(fields({ taskStatus: 'complete', inProgress: ['Still running'] }), null, []);
  assert.match(contradictory.errors.join('; '), /complete status/);
});

test('quality rejects excessive exact duplicates', () => {
  const output = fields({ nextSteps: ['Repeat', 'Repeat', 'Repeat', 'Repeat'] });
  const result = evaluateReflectionQuality(output, null, []);
  assert.match(result.errors.join('; '), /duplicates/);
  assert.equal(result.metrics.duplicateItemCount, 3);
});

test('reflection cannot silently lose an active user-authority item', () => {
  const decision = {
    id: 'decision-refresh', kind: 'decision', topic: 'refresh', content: 'Do not refresh', status: 'active', authority: 'user',
    sourceEntryIds: ['u1'], sourceScoreIds: ['s1'], updatedAt: '2026-01-01T00:00:00Z',
  };
  const source = fields({ durableItems: [decision] });
  const result = evaluateReflectionQuality(fields({ durableItems: [] }), source, []);
  assert.match(result.errors.join('; '), /active user durable items disappeared/);
  assert.equal(result.metrics.lostUserItemCount, 1);
});
