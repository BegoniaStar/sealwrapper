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
  // Both packages are runtime dependencies.  RushStack currently exposes a
  // Node condition before its ESM condition, so bundling it would embed its
  // CommonJS argparse wrapper and fail on dynamic builtin requires in an ESM
  // bundle.  Keeping the parser and spinner external also makes npm's normal
  // dependency installation semantics explicit.
  external: ['@rushstack/ts-command-line', 'ora', 'esbuild', 'typescript'],
  format: 'esm',
  outfile: output,
  platform: 'node',
  sourcemap: false,
  target: 'node26',
});
