import assert from 'node:assert/strict';
import test from 'node:test';

import { createDirtyRebuilder } from '../../src/cli.ts';

test('watch rebuilder coalesces events and performs a follow-up build for changes during a build', async () => {
  let runs = 0;
  let beginFirst: (() => void) | undefined;
  let finishFirst: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { beginFirst = resolve; });
  const release = new Promise<void>((resolve) => { finishFirst = resolve; });
  const rebuilder = createDirtyRebuilder(async () => {
    runs += 1;
    if (runs === 1) {
      beginFirst?.();
      await release;
    }
  }, 1);
  rebuilder.notify();
  await started;
  rebuilder.notify();
  finishFirst?.();
  await new Promise((resolve) => setTimeout(resolve, 25));
  rebuilder.stop();
  assert.equal(runs, 2);
});
