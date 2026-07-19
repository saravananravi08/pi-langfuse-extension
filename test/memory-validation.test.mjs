import assert from 'node:assert/strict';
import test from 'node:test';
import { MEMORY_ARRAY_FIELDS, validateMemoryOutput } from '../memory-validation.js';

function validOutput(kind = 'observer') {
  const value = {
    summary: 'Summary',
    currentTask: 'Continue work',
    taskStatus: 'active',
  };
  value[kind === 'reflection' ? 'reflectionMarkdown' : 'observationsMarkdown'] = 'Memory';
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

test('requires non-empty canonical markdown and summary', () => {
  const value = validOutput('reflection');
  value.reflectionMarkdown = ' ';
  assert.equal(validateMemoryOutput(value, 'reflection'), 'reflectionMarkdown must be a non-empty string');
});
