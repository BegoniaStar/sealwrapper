import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../../src/cli.ts';

test('init creates a schema-v1 resource project with lock and no legacy extension.json', async () => {
  const destination = join(tmpdir(), `sealwrapper-init-${Date.now()}`);
  await runCli(['init', destination, '--kind', 'resource', '--no-sync'], { cwd: process.cwd(), write: () => {} });
  const config = JSON.parse(await readFile(join(destination, 'seal.config.json'), 'utf8'));
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.build, undefined);
  await access(join(destination, 'seal.lock'));
  assert.match(await readFile(join(destination, 'sealw'), 'utf8'), /npx --no-install sealwrapper/);
  await assert.rejects(() => access(join(destination, 'extension.json')));
});

test('init creates a minimal JS unit test required by the JS release gate', async () => {
  const destination = join(tmpdir(), `sealwrapper-init-js-${Date.now()}`);
  await runCli(['init', destination, '--kind', 'js', '--no-sync'], { cwd: process.cwd(), write: () => {} });
  assert.match(await readFile(join(destination, 'tests', 'unit', 'extension.test.ts'), 'utf8'), /node:test/);
  assert.match(await readFile(join(destination, 'tsconfig.json'), 'utf8'), /sealdice-1\.6\.0\.d\.ts/);
  await access(join(destination, '.seal', 'types', 'sealdice-1.6.0.d.ts'));
});

test('CLI can sync and verify the exact target declaration contract without a core checkout', async () => {
  const destination = join(tmpdir(), `sealwrapper-types-cli-${Date.now()}`);
  await runCli(['init', destination, '--kind', 'js', '--no-sync'], { cwd: process.cwd(), write: () => {} });
  const lines: string[] = [];
  await runCli(['types', 'verify'], { cwd: destination, write: (line) => lines.push(line) });
  await runCli(['types', 'sync'], { cwd: destination, write: (line) => lines.push(line) });
  assert.ok(lines.some((line) => /Type contract verified/.test(line)));
  assert.ok(lines.some((line) => /Type contract synced/.test(line)));
});

test('doctor verifies the local Git and lock-pinned Go toolchain before core sync', async () => {
  const destination = join(tmpdir(), `sealwrapper-doctor-${Date.now()}`);
  await runCli(['init', destination, '--kind', 'resource', '--no-sync'], { cwd: process.cwd(), write: () => {} });
  const lines: string[] = [];
  await runCli(['doctor'], { cwd: destination, write: (line) => lines.push(line) });
  assert.match(lines.join('\n'), /Node .*Git git version .*Go go version go1\.25\.0 .*target 1\.6\.0/);
});

test('type contract updates require an explicit write acknowledgement before accessing core', async () => {
  await assert.rejects(
    () => runCli(['types', 'update'], { cwd: process.cwd(), write: () => {} }),
    /--write/,
  );
});

test('CLI exposes only sealpack packaging and exact target 1.6.0', async () => {
  await assert.rejects(() => runCli(['package', '--format', 'js'], { cwd: process.cwd(), write: () => {} }), /sealpack-only/i);
  await assert.rejects(() => runCli(['resource', 'check', '--target', '1.5.1'], { cwd: process.cwd(), write: () => {} }), /1\.6\.0/);
  await assert.rejects(() => runCli(['core', 'sync', '--core', '/tmp/core'], { cwd: process.cwd(), write: () => {} }), /user-supplied core/i);
});

test('P2 CLI rejects invalid report controls before it accesses a managed core', async () => {
  await assert.rejects(() => runCli(['scenario', 'test', '--theme', 'neon'], { cwd: process.cwd(), write: () => {} }), /--theme/);
  await assert.rejects(() => runCli(['scenario', 'test', '--snapshot', '--update-snapshots'], { cwd: process.cwd(), write: () => {} }), /cannot be combined/);
  await assert.rejects(() => runCli(['scenario', 'test', '--png'], { cwd: process.cwd(), write: () => {} }), /--png requires --render/);
});
