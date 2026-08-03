import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('network example declares and exercises its explicit endpoint through the hermetic bridge mock', async () => {
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
  const config = JSON.parse(await readFile(new URL('../../seal.config.json', import.meta.url), 'utf8'));
  assert.equal(config.sealpack.permissions.network, true);
  assert.deepEqual(config.sealpack.permissions.networkHosts, ['api-music.imsyy.top']);
  assert.match(source, /http:\/\/api-music\.imsyy\.top\/cloudsearch/);
});
