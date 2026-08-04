import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { archiveSealpack, createZipArchive, zipArchiveLimitsForCapabilities, zipEntryNames } from '../../src/archive.ts';

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
  await assert.rejects(
    () => createZipArchive([{ path: 'repeated.txt', data: Buffer.alloc(4_096, 0) }], { compressionRatio: 2 }),
    /compression ratio limit/,
  );
});

test('target-matrix archive limits use the most restrictive bridge capability', () => {
  const limits = zipArchiveLimitsForCapabilities([
    { limits: { maxFiles: 10, maxArchiveBytes: 1_000, maxExpandedBytes: 2_000, maxCompressionRatio: 100 } },
    { limits: { maxFiles: 8, maxArchiveBytes: 900, maxExpandedBytes: 1_500, maxCompressionRatio: 50 } },
  ]);
  assert.deepEqual(limits, { entries: 8, compressedSize: 900, expandedSize: 1_500, compressionRatio: 50 });
});
