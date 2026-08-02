import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runJsReleaseQualityGate } from '../../src/quality.ts';

function config() {
  return {
    build: { entry: 'src/index.ts', ecmaTarget: 'es6', bundleFileName: 'quality.js' },
    sealpack: { contents: { scripts: { bundle: true, path: 'scripts/quality.js' } } },
  };
}

test('JS release quality gate parses TypeScript source with type annotations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-quality-'));
  await Promise.all([mkdir(join(root, 'src'), { recursive: true }), mkdir(join(root, 'tests', 'unit'), { recursive: true })]);
  await writeFile(join(root, 'src', 'index.ts'), 'const answer: number = 42;\nvoid answer;\n');
  await writeFile(join(root, 'tests', 'unit', 'source.test.ts'), "import test from 'node:test';\ntest('source fixture', () => {});\n");
  await assert.doesNotReject(() => runJsReleaseQualityGate(root, config()));
});
