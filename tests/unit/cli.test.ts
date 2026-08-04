import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { runCli } from '../../src/cli.ts';

const execFileAsync = promisify(execFile);

test('npm-style symlink launcher resolves the package source entry point', async () => {
  const destination = join(tmpdir(), `sealwrapper-launcher-${Date.now()}`);
  await mkdir(destination, { recursive: true });
  const linkedLauncher = join(destination, 'sealw');
  await symlink(join(process.cwd(), 'sealw'), linkedLauncher);
  const result = await execFileAsync(linkedLauncher, ['--help'], { cwd: destination });
  assert.match(result.stdout, /^Usage: sealwrapper\|sealw /);
});

test('packed global CLI uses compiled JavaScript outside node_modules type stripping', async () => {
  const destination = join(tmpdir(), `sealwrapper-global-${Date.now()}`);
  const prefix = join(destination, 'prefix');
  await mkdir(destination, { recursive: true });
  const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { name: string; version: string };
  await execFileAsync('npm', ['pack', '--pack-destination', destination], { cwd: process.cwd() });
  await execFileAsync('npm', ['install', '--global', '--ignore-scripts', '--prefix', prefix, join(destination, `${manifest.name}-${manifest.version}.tgz`)], { cwd: destination });
  const launcher = join(prefix, 'bin', 'sealw');
  const result = await execFileAsync(launcher, ['--help'], { cwd: destination });
  assert.match(result.stdout, /^Usage: sealwrapper\|sealw /);
  await execFileAsync(launcher, ['init', 'project', '--kind', 'js', '--no-sync'], { cwd: destination });
  await execFileAsync(launcher, ['typecheck'], { cwd: join(destination, 'project') });
});

test('init creates a schema-v2 resource project with a target-aware lock', async () => {
  const destination = join(tmpdir(), `sealwrapper-init-${Date.now()}`);
  await runCli(['init', destination, '--kind', 'resource', '--no-sync'], { cwd: process.cwd(), write: () => {} });
  const config = JSON.parse(await readFile(join(destination, 'seal.config.json'), 'utf8'));
  assert.equal(config.$schema, 'https://raw.githubusercontent.com/BegoniaStar/sealwrapper/main/schemas/seal.config.schema.json');
  assert.equal(config.schemaVersion, 2);
  assert.deepEqual(config.sealDice.buildTarget, ['1.6.0']);
  assert.equal(config.sealDice.defaultTarget, '1.6.0');
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

test('CLI can sync and verify a target declaration contract without a core checkout', async () => {
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
  assert.match(lines.join('\n'), /Node .*Git git version .*Go go version go1\.25\.0 .*targets 1\.6\.0/);
});

test('type contract updates require an explicit write acknowledgement before accessing core', async () => {
  await assert.rejects(
    () => runCli(['types', 'update'], { cwd: process.cwd(), write: () => {} }),
    /--write/,
  );
});

test('CLI exposes only sealpack packaging and registered targets', async () => {
  await assert.rejects(() => runCli(['package', '--format', 'js'], { cwd: process.cwd(), write: () => {} }), /sealpack-only/i);
  await assert.rejects(() => runCli(['package', '--format=js'], { cwd: process.cwd(), write: () => {} }), /sealpack-only/i);
  await assert.rejects(() => runCli(['package', '--target', '1.6.0'], { cwd: process.cwd(), write: () => {} }), /--target|Unrecognized arguments/i);
  await assert.rejects(() => runCli(['resource', 'check', '--target', '1.5.1'], { cwd: process.cwd(), write: () => {} }), /1\.6\.0/);
  await assert.rejects(() => runCli(['core', 'sync', '--core', '/tmp/core'], { cwd: process.cwd(), write: () => {} }), /user-supplied core/i);
  await assert.rejects(() => runCli(['core', 'sync', '--core=/tmp/core'], { cwd: process.cwd(), write: () => {} }), /user-supplied core/i);
});

test('RushStack command definitions render root and legacy two-token action help', async () => {
  const lines: string[] = [];
  await runCli(['--help'], { cwd: process.cwd(), write: (line) => lines.push(line) });
  assert.match(lines[0], /^Usage: sealwrapper\|sealw /);
  lines.length = 0;
  await runCli(['scenario', 'test', '--help'], { cwd: process.cwd(), write: (line) => lines.push(line) });
  assert.match(lines[0], /^Usage: sealwrapper\|sealw scenario test /);
  assert.match(lines.join('\n'), /--update-snapshots/);
});

test('RushStack parser rejects unknown options, duplicate targets, and extra init positionals', async () => {
  const silent = { cwd: process.cwd(), write: () => {} };
  await assert.rejects(() => runCli(['test', '--typo'], silent), /Unrecognized arguments/);
  await assert.rejects(() => runCli(['test', '--target', '1.6.0', '--target', '1.6.0'], silent), /only be specified once/);
  await assert.rejects(() => runCli(['test', '--target=1.6.0', '--target=1.6.0'], silent), /only be specified once/);
  await assert.rejects(() => runCli(['init', 'one', 'two', '--no-sync'], silent), /exactly one destination/);
});

test('P2 CLI rejects invalid report controls before it accesses a managed core', async () => {
  await assert.rejects(() => runCli(['scenario', 'test', '--theme', 'neon'], { cwd: process.cwd(), write: () => {} }), /--theme/);
  await assert.rejects(() => runCli(['scenario', 'test', '--snapshot', '--update-snapshots'], { cwd: process.cwd(), write: () => {} }), /cannot be combined/);
  await assert.rejects(() => runCli(['scenario', 'test', '--png'], { cwd: process.cwd(), write: () => {} }), /--png requires --render/);
});

test('repro verify builds the complete configured matrix twice without core access', async () => {
  const lines: string[] = [];
  await runCli(['repro', 'verify'], { cwd: join(process.cwd(), 'examples', '002-author-information'), write: (line) => lines.push(line) });
  assert.match(lines.join('\n'), /Reproducible sealpack: sha256:/);
});

test('scenario test fails before core access when its scenario directory is empty', async () => {
  const destination = join(tmpdir(), `sealwrapper-empty-scenarios-${Date.now()}`);
  await mkdir(join(destination, 'tests', 'scenarios'), { recursive: true });
  await assert.rejects(
    () => runCli(['scenario', 'test'], { cwd: destination, write: () => {} }),
    /No scenario files found under tests\/scenarios/,
  );
});

test('scenario test rejects an additional sealpack symlink before it accesses a managed core', async (t) => {
  const destination = join(tmpdir(), `sealwrapper-scenario-package-symlink-${Date.now()}`);
  const outside = join(tmpdir(), `sealwrapper-outside-package-${Date.now()}.sealpack`);
  await runCli(['init', destination, '--kind', 'resource', '--no-sync'], { cwd: process.cwd(), write: () => {} });
  await mkdir(join(destination, 'tests', 'scenarios'), { recursive: true });
  await writeFile(outside, 'outside package');
  try {
    await symlink(outside, join(destination, 'linked.sealpack'));
  } catch (error: any) {
    if (error?.code === 'EPERM') return t.skip('symlinks are unavailable on this platform');
    throw error;
  }
  await writeFile(join(destination, 'tests', 'scenarios', 'linked.json'), `${JSON.stringify({ messages: [], packages: ['linked.sealpack'] })}\n`);
  await assert.rejects(
    () => runCli(['scenario', 'test'], { cwd: destination, write: () => {} }),
    /Scenario package must not be a symbolic link: linked\.sealpack/,
  );
});
