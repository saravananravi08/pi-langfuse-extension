import assert from 'node:assert/strict';
import test from 'node:test';
import { MEMORY_ARRAY_FIELDS, validateMemoryOutput } from '../memory-validation.js';

function validOutput(kind = 'observer') {
  const value = {
    summary: 'Summary',
    currentTask: 'Continue work',
    taskStatus: 'active',
  };
  if (kind === 'observer') value.observationsMarkdown = 'Memory';
  for (const field of MEMORY_ARRAY_FIELDS) value[field] = [];
  return value;
}

test('accepts complete observer and reflection schemas', () => {
  assert.equal(validateMemoryOutput(validOutput(), 'observer'), undefined);
  assert.equal(validateMemoryOutput(validOutput('reflection'), 'reflection'), undefined);
});

test('rejects missing structured fields', () => {
  const value = validOutput();
  delete value.completed;
  assert.equal(validateMemoryOutput(value, 'observer'), 'completed must be an array of strings');
});

test('rejects invalid array values and missing task status', () => {
  const arrayValue = validOutput();
  arrayValue.nextSteps = ['valid', 1];
  assert.equal(validateMemoryOutput(arrayValue, 'observer'), 'nextSteps must be an array of strings');

  const statusValue = validOutput('reflection');
  statusValue.taskStatus = '';
  assert.equal(validateMemoryOutput(statusValue, 'reflection'), 'taskStatus must be a non-empty string');
});

test('requires observer markdown and summary', () => {
  const observer = validOutput();
  observer.observationsMarkdown = ' ';
  assert.equal(validateMemoryOutput(observer, 'observer'), 'observationsMarkdown must be a non-empty string');

  const reflection = validOutput('reflection');
  reflection.summary = '';
  assert.equal(validateMemoryOutput(reflection, 'reflection'), 'summary must be a non-empty string');
});
