import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { archiveSealpack, createZipArchive, zipEntryNames } from '../../src/archive.ts';

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

test('sealpack producer enforces expanded and compressed archive limits before publishing', async () => {
  await assert.rejects(
    () => createZipArchive([{ path: 'large.txt', data: Buffer.alloc(8, 0x41) }], { expandedSize: 4 }),
    /expanded limit/,
  );
  await assert.rejects(
    () => createZipArchive([{ path: 'entry.txt', data: Buffer.from('archive') }], { compressedSize: 32 }),
    /compressed limit/,
  );
});
