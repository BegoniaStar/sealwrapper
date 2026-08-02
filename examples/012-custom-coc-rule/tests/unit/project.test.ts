import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('custom COC rule keeps the documented key, index, critical, and fumble values', async () => {
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /rule\.index = 20/);
  assert.match(source, /rule\.key = '测试'/);
  assert.match(source, /criticalSuccessValue = 1/);
  assert.match(source, /fumbleValue = 100/);
});
