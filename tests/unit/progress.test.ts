import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

import { createProgress, type ProgressReporter, withProgress } from '../../src/progress.ts';

test('captured progress is silent and does not alter the output stream', async () => {
  const chunks: string[] = [];
  const stream = {
    isTTY: true,
    write(chunk: string) { chunks.push(chunk); return true; },
  } as unknown as NodeJS.WriteStream;
  const progress = createProgress({ captured: true, enabled: true, stream });
  progress.start('working');
  progress.update('still working');
  progress.succeed('done');
  await withProgress(progress, 'wrapped', async () => 42);
  progress.fail('ignored');
  progress.stop();
  assert.deepEqual(chunks, []);
});

test('withProgress reports success and always stops the reporter', async () => {
  const events: string[] = [];
  const progress: ProgressReporter = {
    start: (text) => events.push(`start:${text}`),
    update: (text) => events.push(`update:${text}`),
    succeed: (text) => events.push(`succeed:${text}`),
    fail: (text) => events.push(`fail:${text}`),
    stop: () => events.push('stop'),
  };

  const result = await withProgress(progress, 'compile', async () => 42, 'compiled');
  assert.equal(result, 42);
  assert.deepEqual(events, ['start:compile', 'succeed:compiled', 'stop']);
});

test('withProgress reports failures, cleans up, and preserves the original error', async () => {
  const events: string[] = [];
  const progress: ProgressReporter = {
    start: (text) => events.push(`start:${text}`),
    update: (text) => events.push(`update:${text}`),
    succeed: (text) => events.push(`succeed:${text}`),
    fail: (text) => events.push(`fail:${text}`),
    stop: () => events.push('stop'),
  };
  const expected = new Error('bridge failed');

  await assert.rejects(
    () => withProgress(progress, 'bridge', async () => { throw expected; }),
    /bridge failed/,
  );
  assert.deepEqual(events, ['start:bridge', 'fail:bridge failed', 'stop']);
});

test('createProgress is silent for non-interactive, CI, and NO_COLOR output', () => {
  const chunks: string[] = [];
  const stream = {
    isTTY: false,
    write(chunk: string) { chunks.push(chunk); return true; },
  } as unknown as NodeJS.WriteStream;
  const previousCi = process.env.CI;
  const previousNoColor = process.env.NO_COLOR;
  try {
    delete process.env.CI;
    delete process.env.NO_COLOR;
    let progress = createProgress({ stream });
    progress.start('non-tty');
    progress.succeed('done');

    process.env.CI = '1';
    progress = createProgress({ stream, enabled: true });
    progress.start('ci');
    progress.fail('failed');

    delete process.env.CI;
    process.env.NO_COLOR = '1';
    progress = createProgress({ stream, enabled: true });
    progress.start('no-color');
    progress.stop();
  }
  finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
  assert.deepEqual(chunks, []);
});

test('enabled ora progress can start, update, succeed, fail, and stop cleanly', () => {
  const chunks: Buffer[] = [];
  const stream = Object.assign(new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  }), {
    isTTY: true,
    columns: 80,
    cursorTo: () => true,
    moveCursor: () => true,
    clearLine: () => true,
  }) as NodeJS.WritableStream & { isTTY?: boolean };
  stream.isTTY = true;
  const previousCi = process.env.CI;
  const previousNoColor = process.env.NO_COLOR;
  try {
    delete process.env.CI;
    delete process.env.NO_COLOR;
    const progress = createProgress({ stream, enabled: true });
    progress.start('working');
    progress.update('still working');
    progress.succeed('done');
    progress.start('failing');
    progress.fail('failed');
    progress.stop();
  }
  finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
  assert.ok(chunks.length > 0);
});

test('withProgress returns values when no reporter is supplied', async () => {
  assert.equal(await withProgress(undefined, 'noop', async () => 'value'), 'value');
});
