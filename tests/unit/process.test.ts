import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('process runner terminates a timed-out POSIX process group', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-process-group-'));
  const marker = join(root, 'descendant-survived');
  const childProgram = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected'), 300)`;
  const parentProgram = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}], { stdio: 'ignore' }); setInterval(() => {}, 1_000)`;
  try {
    const result = await runProcess(process.execPath, ['-e', parentProgram], { timeoutMs: 50, maxOutputBytes: 1_024 });
    assert.equal(result.timedOut, true);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 450));
    await assert.rejects(() => access(marker));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
