import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { archiveSealpack, zipEntryNames } from '../../src/archive.ts';

const staged = {
  packageId: 'tester/cards', version: '1.0.0', manifest: 'format_version = "1.0.0"\n',
  files: [
    { path: 'reply/hello.yaml', data: Buffer.from('items: []\n') },
    { path: 'info.toml', data: Buffer.from('format_version = "1.0.0"\n') },
    { path: 'decks/cards.json', data: Buffer.from('{"cards":["yes"]}\n') },
  ],
};

test('sealpack archive is deterministic, sorted, and contains only staged files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-archive-'));
  const first = join(root, 'first.sealpack');
  const second = join(root, 'second.sealpack');
  await archiveSealpack(staged, first);
  await archiveSealpack(staged, second);
  assert.deepEqual(await readFile(first), await readFile(second));
  assert.deepEqual(zipEntryNames(await readFile(first)), ['decks/cards.json', 'info.toml', 'reply/hello.yaml']);
});
