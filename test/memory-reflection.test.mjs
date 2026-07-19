import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateReflectionQuality, renderReflectionMarkdown } from '../memory-reflection.js';
import { REQUIRED_REFLECTION_HEADINGS } from '../memory-prompts.js';

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

test('renders empty sections without inventing content', () => {
  const markdown = renderReflectionMarkdown(fields({ openIssues: [], filesDeleted: [] }));
  assert.match(markdown, /### Blocked\n\n## Key Decisions/);
  assert.match(markdown, /### Files Deleted\n### Tools Used/);
  assert.doesNotMatch(markdown, /None|N\/A/);
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
