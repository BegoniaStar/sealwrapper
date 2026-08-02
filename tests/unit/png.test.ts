import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { rasterizeSvgToPng } from '../../src/png.ts';

test('PNG exporter prefers rsvg-convert and atomically publishes its output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-png-'));
  const svg = join(root, 'report.svg');
  const png = join(root, 'report.png');
  const calls: string[] = [];
  await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await rasterizeSvgToPng({ svg, png }, async (program, args) => {
    calls.push(program);
    await writeFile(args[2]!, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  assert.deepEqual(calls, ['rsvg-convert']);
  await access(png);
  assert.deepEqual(await readFile(png), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

test('PNG exporter falls back to local ImageMagick only when rsvg-convert is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-png-fallback-'));
  const svg = join(root, 'report.svg');
  const png = join(root, 'report.png');
  const calls: string[] = [];
  await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await rasterizeSvgToPng({ svg, png }, async (program, args) => {
    calls.push(program);
    if (program === 'rsvg-convert') {
      const error = Object.assign(new Error('not found'), { code: 'ENOENT' });
      throw error;
    }
    await writeFile(args[1]!, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  assert.deepEqual(calls, ['rsvg-convert', 'magick']);
  await access(png);
});
