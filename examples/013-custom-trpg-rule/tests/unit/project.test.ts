import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('TRPG example registers its fish template and command paths', async () => {
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /name: 'fish'/);
  assert.match(source, /seal\.gameSystem\.newTemplate/);
  assert.match(source, /action === '规则'/);
  assert.match(source, /action === 'clr'/);
});
