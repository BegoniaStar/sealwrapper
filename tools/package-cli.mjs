import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist', 'cli.js');

await mkdir(dirname(output), { recursive: true });
await build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: ['src/cli.ts'],
  external: ['esbuild', 'typescript'],
  format: 'esm',
  outfile: output,
  platform: 'node',
  sourcemap: false,
  target: 'node26',
});
