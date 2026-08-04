import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../../src/cli.ts';
import { renderOutput } from '../../src/output.ts';

const projectRoot = process.cwd();

async function newWorkspace(prefix: string, t: test.TestContext): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return join(parent, 'project');
}

async function initProject(root: string, kind: 'js' | 'resource' | 'hybrid' = 'resource') {
  await runCli(['init', root, '--kind', kind, '--no-sync'], { cwd: projectRoot, write: () => {} });
}

test('help aliases and target normalization preserve the documented command tree', async () => {
  const lines: string[] = [];
  await runCli([], { cwd: projectRoot, write: (line) => lines.push(line) });
  assert.match(lines.join('\n'), /^Usage: sealwrapper\|sealw /);

  lines.length = 0;
  await runCli(['help'], { cwd: projectRoot, write: (line) => lines.push(line) });
  assert.match(lines[0], /^Usage: sealwrapper\|sealw /);

  lines.length = 0;
  await runCli(['help', 'types', 'audit'], { cwd: projectRoot, write: (line) => lines.push(line) });
  assert.match(lines[0], /^Usage: sealwrapper\|sealw types audit /);
  assert.match(lines.join('\n'), /API inventory/);

  lines.length = 0;
  await runCli(['--target=1.6.0', 'scenario', 'test', '-h'], { cwd: projectRoot, write: (line) => lines.push(line) });
  assert.match(lines[0], /^Usage: sealwrapper\|sealw scenario test /);
  assert.match(lines.join('\n'), /--target \{1\.6\.0\}/);
});

test('captured parser failures do not leak usage text or leave stream hooks installed', async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  await assert.rejects(
    () => runCli(['unknown-command'], { cwd: projectRoot, write: (line) => lines.push(line) }),
    /Invalid choice|unknown/i,
  );

  assert.deepEqual(lines, []);
  assert.equal(console.log, originalLog);
  assert.equal(console.error, originalError);
  assert.equal(process.stdout.write, originalStdoutWrite);
  assert.equal(process.stderr.write, originalStderrWrite);
});

test('strict target parsing rejects missing, inline-empty, and mixed duplicate forms', async () => {
  const silent = { cwd: projectRoot, write: () => {} };
  await assert.rejects(() => runCli(['test', '--target'], silent), /requires a value/);
  await assert.rejects(() => runCli(['test', '--target='], silent), /requires a value/);
  await assert.rejects(() => runCli(['test', '--target', '1.6.0', '--target=1.6.0'], silent), /only be specified once/);
});

test('init accepts options before its destination and writes the requested resource shape', async (t) => {
  const root = await newWorkspace('sealwrapper-init-order-', t);
  const lines: string[] = [];
  await runCli(['init', '--kind', 'resource', '--no-sync', '--target=1.6.0', root], { cwd: projectRoot, write: (line) => lines.push(line) });

  const config = JSON.parse(await readFile(join(root, 'seal.config.json'), 'utf8')) as any;
  assert.equal(config.build, undefined);
  assert.deepEqual(Object.keys(config.sealpack.contents).sort(), ['decks', 'reply']);
  assert.match(lines.join('\n'), /Created sealpack-only resource project/);

  await assert.rejects(
    () => runCli(['init', '--no-sync'], { cwd: projectRoot, write: () => {} }),
    /exactly one destination directory/,
  );
});

test('watch once rebuilds JavaScript staging while resource projects reject JS-only actions', async (t) => {
  const jsRoot = await newWorkspace('sealwrapper-watch-once-', t);
  await initProject(jsRoot, 'js');
  const lines: string[] = [];
  await runCli(['watch', '--once'], { cwd: jsRoot, write: (line) => lines.push(line) });
  assert.match(lines.join('\n'), /Watch build ready: .*\.sealpack/);

  const resourceRoot = await newWorkspace('sealwrapper-resource-actions-', t);
  await initProject(resourceRoot, 'resource');
  await assert.rejects(
    () => runCli(['watch', '--once'], { cwd: resourceRoot, write: () => {} }),
    /watch is available only to projects with a build entry/,
  );
  await assert.rejects(
    () => runCli(['typecheck'], { cwd: resourceRoot, write: () => {} }),
    /typecheck is available only to projects with a JS bundle/,
  );
});

test('lock update supports explicit dirty-mode writes and reports malformed locks', async (t) => {
  const root = await newWorkspace('sealwrapper-lock-update-', t);
  await mkdir(root, { recursive: true });
  const lines: string[] = [];
  await runCli(['lock', 'update', '--allow-dirty', '--target=1.6.0'], { cwd: root, write: (line) => lines.push(line) });
  const lock = JSON.parse(await readFile(join(root, 'seal.lock'), 'utf8')) as any;
  assert.equal(lock.lockVersion, 3);
  assert.equal(lock.registryVersion, 2);
  assert.deepEqual(lock.buildTargets, ['1.6.0']);
  assert.equal(lock.defaultTarget, '1.6.0');
  assert.deepEqual(Object.keys(lock.targets), ['1.6.0']);
  assert.match(lines.join('\n'), /Updated seal\.lock for target set: 1\.6\.0/);

  lines.length = 0;
  await runCli(['lock', 'update', '--allow-dirty'], { cwd: root, write: (line) => lines.push(line) });
  assert.match(lines.join('\n'), /No lock contract changes/);

  const legacyLock = JSON.parse(await readFile(join(root, 'seal.lock'), 'utf8')) as any;
  legacyLock.lockVersion = 2;
  await writeFile(join(root, 'seal.lock'), `${JSON.stringify(legacyLock, null, 2)}\n`);
  lines.length = 0;
  await runCli(['lock', 'update', '--allow-dirty'], { cwd: root, write: (line) => lines.push(line) });
  assert.equal(JSON.parse(await readFile(join(root, 'seal.lock'), 'utf8')).lockVersion, 3);
  assert.match(lines.join('\n'), /lockVersion: 2 -> 3/);

  await writeFile(join(root, 'seal.lock'), JSON.stringify({ lockVersion: 1, targets: {} }));
  await assert.rejects(
    () => runCli(['lock', 'update', '--allow-dirty'], { cwd: root, write: () => {} }),
    /seal\.lock must use lockVersion: 2 or 3.*migration/,
  );

  const malformedRoot = await newWorkspace('sealwrapper-lock-malformed-', t);
  await mkdir(malformedRoot, { recursive: true });
  await writeFile(join(malformedRoot, 'seal.lock'), '{not-json\n');
  await assert.rejects(
    () => runCli(['lock', 'update', '--allow-dirty'], { cwd: malformedRoot, write: () => {} }),
    /seal\.lock is not valid JSON/,
  );

  const noGitRoot = await newWorkspace('sealwrapper-lock-no-git-', t);
  await assert.rejects(
    () => runCli(['lock', 'update'], { cwd: noGitRoot, write: () => {} }),
    /requires a Git worktree or explicit --allow-dirty/,
  );
});

test('doctor reports both unavailable Git and mismatched Go toolchains', async (t) => {
  const root = await newWorkspace('sealwrapper-doctor-errors-', t);
  await initProject(root, 'resource');
  const bin = await mkdtemp(join(tmpdir(), 'sealwrapper-doctor-bin-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const git = join(bin, 'git');
  const go = join(bin, 'go');
  await writeFile(git, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await writeFile(go, '#!/bin/sh\nprintf "%s\\n" "go version go1.25.0 linux/amd64"\n', { mode: 0o700 });
  await chmod(git, 0o700);
  await chmod(go, 0o700);

  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    await assert.rejects(
      () => runCli(['doctor'], { cwd: root, write: () => {} }),
      /Git is required by seal\.lock/,
    );

    await writeFile(git, '#!/bin/sh\nprintf "%s\\n" "git version 2.45.0"\n', { mode: 0o700 });
    await writeFile(go, '#!/bin/sh\nprintf "%s\\n" "go version go1.24.0 linux/amd64"\n', { mode: 0o700 });
    await assert.rejects(
      () => runCli(['doctor'], { cwd: root, write: () => {} }),
      /Go 1\.25\.0 required by seal\.lock; found go version go1\.24\.0/,
    );
  }
  finally {
    process.env.PATH = previousPath;
  }
});

test('CLI emits one stable JSON or JUnit envelope for machine-readable runs', async (t) => {
  const root = await newWorkspace('sealwrapper-output-format-', t);
  const jsonLines: string[] = [];
  await runCli(['init', '--kind', 'resource', '--no-sync', root, '--format=json'], { cwd: projectRoot, write: (line) => jsonLines.push(line) });
  const json = JSON.parse(jsonLines.join('\n')) as any;
  assert.deepEqual(Object.keys(json).sort(), ['command', 'format', 'messages', 'ok']);
  assert.equal(json.format, 'sealwrapper.cli/v1');
  assert.equal(json.command, 'init');
  assert.equal(json.ok, true);
  assert.match(json.messages.join('\n'), /Created sealpack-only resource/);

  const junitLines: string[] = [];
  await runCli(['doctor', '--format', 'junit'], { cwd: root, write: (line) => junitLines.push(line) });
  assert.match(junitLines.join('\n'), /^<testsuite name="sealwrapper" tests="1" failures="0"/);
  assert.match(junitLines.join('\n'), /<testcase[^>]+name="doctor"/);
});

test('machine output preserves target and scenario test case boundaries', () => {
  const cases = [
    { classname: 'sealwrapper.scenario.1.6.0', name: 'smoke.json', durationMilliseconds: 15, output: 'Scenario: Smoke' },
    { classname: 'sealwrapper.scenario.1.6.0', name: 'network.json', durationMilliseconds: 25, failure: 'network expectation failed' },
  ];
  const junit = renderOutput('junit', 'scenario:test', false, ['Scenario passed: smoke.json (1.6.0)'], { message: 'network expectation failed', exitCode: 1 }, cases);
  assert.match(junit, /tests="2" failures="1"/);
  assert.match(junit, /classname="sealwrapper\.scenario\.1\.6\.0" name="smoke\.json" time="0\.015"/);
  assert.match(junit, /name="network\.json" time="0\.025"><failure message="network expectation failed"/);
  assert.doesNotMatch(junit, /classname="sealwrapper" name="scenario:test"/);

  const json = JSON.parse(renderOutput('json', 'scenario:test', false, [], { message: 'network expectation failed', exitCode: 1 }, cases));
  assert.deepEqual(json.tests, cases);
});
