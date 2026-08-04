import assert from 'node:assert/strict';
import test from 'node:test';

import { runProcess } from '../../src/process.ts';

test('process runner terminates a command that exceeds its combined output budget', async () => {
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(1024))"], { timeoutMs: 5_000, maxOutputBytes: 128 });
  assert.equal(result.outputExceeded, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 128);
});

test('process runner marks timed-out descendants without waiting for their natural exit', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { timeoutMs: 50, maxOutputBytes: 1_024 });
  assert.equal(result.timedOut, true);
});
