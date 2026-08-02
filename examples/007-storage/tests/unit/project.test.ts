import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('storage example reads the item from the first command argument', async () => {
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /const name = item \|\| '空气'/);
  assert.match(source, /extension\.storageSet\('feedInfo'/);
});
