import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('custom command registers .seal and keeps its help path', async () => {
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /cmdSeal\.name = 'seal'/);
  assert.match(source, /name === 'help'/);
  assert.match(source, /Math\.ceil\(Math\.random\(\) \* 100\)/);
});
