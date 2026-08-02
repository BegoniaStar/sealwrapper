import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('delegated roll opts into and reads the delegated context', async () => {
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /command\.allowDelegate = true/);
  assert.match(source, /seal\.getCtxProxyFirst\(ctx, cmdArgs\)/);
  assert.match(source, /Math\.ceil\(Math\.random\(\) \* 100\)/);
});
