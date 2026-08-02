import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('author-information source is intentionally metadata-only', async () => {
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /seal\.config\.json/);
});
