import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('network example retains its explicit endpoint without requesting the network in a bridge run', async () => {
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
  const config = JSON.parse(await readFile(new URL('../../seal.config.json', import.meta.url), 'utf8'));
  assert.match(source, /https:\/\/api-music\.imsyy\.top\/cloudsearch/);
  assert.equal(config.sealpack.permissions.network, false);
  assert.doesNotMatch(source, /\bfetch\(/);
});
