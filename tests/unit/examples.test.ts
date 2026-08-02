import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { projects, unitTests } from '../../tools/test-examples.ts';

test('examples regression discovers every lock-backed project and its unit suite', async () => {
  const roots = await projects();
  assert.equal(roots.length, 11);
  assert.ok(roots.every((root) => root.endsWith('/examples/002-author-information') || root.includes('/examples/')));
  for (const root of roots) {
    assert.ok((await unitTests(root)).length >= 1, `${root} must have a unit test`);
    const ignored = await readFile(join(root, '.gitignore'), 'utf8');
    for (const generated of ['.seal/', 'dist/', 'release/', '*.sealpack']) assert.match(ignored, new RegExp(`^${generated.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), `${root} must ignore ${generated} when copied independently`);
  }
});
