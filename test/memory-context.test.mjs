import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMemoryContextText, replaceWithMemoryContext } from '../memory-context.js';

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

test('replaces old history while retaining two complete user turns', () => {
  const messages = [
    { role: 'user', content: 'old user' },
    { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
    { role: 'user', content: 'recent user' },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }] },
    { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: 'result' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'recent answer' }] },
    { role: 'user', content: 'current user' },
  ];

  const replaced = replaceWithMemoryContext(messages, 'memory', 2, 123);
  assert.equal(replaced[0].customType, 'langfuse-memory-context');
  assert.equal(replaced[0].timestamp, 123);
  assert.deepEqual(replaced.slice(1), messages.slice(2));
  assert.equal(replaced.find(message => message.role === 'toolResult')?.toolCallId, 'call-1');
});

test('does not replace context without active memory and removes stale injected copies', () => {
  const messages = [{ role: 'user', content: 'current' }];
  assert.equal(replaceWithMemoryContext(messages, ''), messages);

  const withStale = [
    { role: 'custom', customType: 'langfuse-memory-context', content: 'stale' },
    { role: 'user', content: 'current' },
  ];
  const replaced = replaceWithMemoryContext(withStale, 'fresh', 2, 123);
  assert.equal(replaced.filter(message => message.customType === 'langfuse-memory-context').length, 1);
  assert.equal(replaced[0].content, 'fresh');
});
