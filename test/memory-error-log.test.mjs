import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendMemoryErrorLog, describeMemoryOutput } from '../memory-error-log.js';

test('describes output fields without storing their content', () => {
  const shape = describeMemoryOutput({
    reflectionMarkdown: '',
    summary: 'sensitive summary text',
    goal: ['one'],
    taskStatus: null,
  });
  assert.deepEqual(shape, {
    reflectionMarkdown: { type: 'string', length: 0, nonEmpty: false },
    summary: { type: 'string', length: 22, nonEmpty: true },
    goal: { type: 'array', length: 1, itemTypes: ['string'] },
    taskStatus: { type: 'null' },
  });
  assert.doesNotMatch(JSON.stringify(shape), /sensitive summary text/);
});

test('appends private redacted JSONL diagnostics', () => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-errors-'));
  const path = join(directory, 'nested', 'errors.jsonl');
  appendMemoryErrorLog(path, {
    stage: 'observer-validation',
    error: 'authorization=example-secret',
    apiKey: 'example-credential',
  }, '2026-01-01T00:00:00.000Z');

  const entry = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(entry.timestamp, '2026-01-01T00:00:00.000Z');
  assert.equal(entry.stage, 'observer-validation');
  assert.equal(entry.apiKey, '[REDACTED]');
  assert.equal(entry.error, 'authorization=[REDACTED]');
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
