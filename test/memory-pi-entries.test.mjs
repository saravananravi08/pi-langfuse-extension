import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findPiSessionFile, provenanceEntryIds, readBoundedPiEntries } from '../memory/memory-pi-entries.js';

test('finds session file and returns only bounded redacted provenance entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-memory-entries-'));
  const dir = join(root, '--project--');
  mkdirSync(dir);
  const file = join(dir, 'session-name.jsonl');
  writeFileSync(file, [
    { type: 'session', id: 'pi-session', timestamp: '2026-01-01T00:00:00Z', cwd: '/project' },
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'token=secret-value' } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ].map(JSON.stringify).join('\n'));

  assert.equal(findPiSessionFile(root, 'session-name', 'pi-session'), file);
  const result = readBoundedPiEntries(file, ['u1', 'a1', 'missing'], 2, 100);
  assert.equal(result.returnedEntryCount, 2);
  assert.equal(result.truncated, true);
  assert.match(JSON.stringify(result.entries[0]), /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(result.entries), /secret-value/);
});

test('extracts unique bounded entry IDs from observation and reflection provenance', () => {
  const ids = provenanceEntryIds([
    { metadata: { piProvenance: { entryIds: ['u1', 'a1'] } } },
    { metadata: { sourcePiEntryIds: ['a1', 'u2'] } },
  ], 2);
  assert.deepEqual(ids, ['u1', 'a1']);
});
