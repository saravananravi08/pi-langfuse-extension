import assert from 'node:assert/strict';
import test from 'node:test';
import { abortableSleep, isAbortError } from '../memory/memory-lifecycle.js';

test('cancels pending retry delays immediately', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = abortableSleep(10_000, controller.signal);
  controller.abort(new DOMException('session ended', 'AbortError'));
  await assert.rejects(pending, error => isAbortError(error));
  assert.ok(Date.now() - started < 1000);
});

test('rejects work queued with an already-aborted lifecycle', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('session changed', 'AbortError'));
  await assert.rejects(abortableSleep(1, controller.signal), error => isAbortError(error));
});
