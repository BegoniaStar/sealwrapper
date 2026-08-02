import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { watch as watchFs } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { archiveSealpack } from './archive.ts';
import { auditApiContract, updateApiContract } from './api-contract.ts';
import { invokeBridge } from './bridge.ts';
import { loadProjectConfig } from './config.ts';
import { coreSync, coreVerify } from './core.ts';
import { SealwrapperError } from './errors.ts';
import { describeLockDiff, loadSealLock, renderSealLock } from './lock.ts';
import { pinnedTarget } from './pinned-target.ts';
import { publishReleaseFiles, renderReleaseProvenance } from './release.ts';
import { auditReplyGrammar } from './reply-audit.ts';
import { writeScenarioReport } from './reports.ts';
import { runJsReleaseQualityGate } from './quality.ts';
import { assertTranscriptExpectation, normalizeScenario } from './scenario.ts';
import { toSarif } from './sarif.ts';
import { stageSealpack } from './stage.ts';
import { syncProjectTypes, typecheckProject, verifyProjectTypes } from './types.ts';

type CliOptions = { cwd: string; write?: (line: string) => void };
const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

function output(options: CliOptions, line: string) { (options.write ?? ((value) => process.stdout.write(`${value}\n`)))(line); }

function targetFrom(argumentsList: string[]) {
  const index = argumentsList.indexOf('--target');
  const target = index === -1 ? '1.6.0' : argumentsList[index + 1];
  if (target !== '1.6.0') throw new SealwrapperError('Only exact target 1.6.0 is supported', 2);
  return target;
}

function option(argumentsList: string[], name: string) {
  const index = argumentsList.indexOf(name);
  if (index === -1) return null;
  const value = argumentsList[index + 1];
  if (!value || value.startsWith('--')) throw new SealwrapperError(`${name} requires a value`, 2);
  return value;
}

function packageFileName(staged: any) {
  return `${staged.packageId.split('/')[1]}@${staged.version}.sealpack`;
}

async function exists(path: string) { try { await access(path); return true; } catch { return false; } }

function defaultConfig(kind: string) {
  const scripts = kind === 'js' || kind === 'hybrid';
  const resources = kind === 'resource' || kind === 'hybrid';
  const contents: any = {};
  if (scripts) contents.scripts = { bundle: true, path: 'scripts/example.js' };
  if (resources) { contents.decks = { source: 'content/decks' }; contents.reply = { source: 'content/reply' }; }
  return {
    schemaVersion: 1,
    package: { name: 'My SealDice Package', version: '0.1.0', authors: ['Your Name'], license: 'MIT', description: '', homepage: '' },
    ...(scripts ? { build: { entry: 'src/index.ts', ecmaTarget: 'es6', bundleFileName: 'example.js' } } : {}),
    sealDice: { profiles: [{ id: '1.6.0', kind: 'exact' }], defaultTarget: '1.6.0' },
    release: { directory: 'release', checksum: 'sha256', artifactPolicy: { forbiddenPaths: [], forbiddenExtensions: [] } },
    sealpack: {
      packageId: 'author/my-package', minSealDice: '1.6.0', contents, dependencies: {},
      permissions: { network: false, networkHosts: [], acknowledgeUnrestrictedNetwork: false, fileRead: [], fileWrite: [], dangerous: false, httpServer: false, ipc: [] },
      readme: 'README.md', assets: [], store: { category: 'rules', icon: '', banner: '', screenshots: [] },
    },
  };
}

function defaultTsConfig() {
  return {
    compilerOptions: {
      allowImportingTsExtensions: true,
      module: 'ESNext',
      moduleResolution: 'Bundler',
      noEmit: true,
      strict: true,
      target: 'ES2024',
      types: [],
      verbatimModuleSyntax: true,
    },
    include: ['src/**/*.ts', '.seal/types/sealdice-1.6.0.d.ts'],
  };
}

async function initProject(argumentsList: string[], options: CliOptions) {
  const directory = argumentsList[1];
  if (!directory || directory.startsWith('--')) throw new SealwrapperError('init requires a destination directory', 2);
  const kind = option(argumentsList, '--kind') ?? 'hybrid';
  if (!['js', 'resource', 'hybrid'].includes(kind)) throw new SealwrapperError('init --kind must be js, resource, or hybrid', 2);
  if (targetFrom(argumentsList) !== '1.6.0') throw new SealwrapperError('init only supports target 1.6.0', 2);
  const root = resolve(options.cwd, directory);
  if (await exists(root)) throw new SealwrapperError(`init destination already exists: ${root}`, 2);
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, 'seal.config.json'), `${JSON.stringify(defaultConfig(kind), null, 2)}\n`, { mode: 0o644 }),
    writeFile(join(root, 'seal.lock'), renderSealLock(pinnedTarget), { mode: 0o644 }),
    writeFile(join(root, 'README.md'), '# My SealDice Package\n', { mode: 0o644 }),
    writeFile(join(root, '.gitignore'), '.seal/\ndist/\nrelease/\n*.sealpack\n', { mode: 0o644 }),
    writeFile(join(root, 'sealw'), '#!/bin/sh\n# Uses the project-local, package-lock-pinned sealwrapper installation.\nexec npx --no-install sealwrapper "$@"\n', { mode: 0o755 }),
    ...((kind === 'js' || kind === 'hybrid') ? [writeFile(join(root, 'tsconfig.json'), `${JSON.stringify(defaultTsConfig(), null, 2)}\n`, { mode: 0o644 })] : []),
  ]);
  await chmod(join(root, 'sealw'), 0o755);
  if (kind === 'js' || kind === 'hybrid') {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'index.ts'), '// Bundle entry point. Register your SealDice extension here.\n', { mode: 0o644 });
    await mkdir(join(root, 'tests', 'unit'), { recursive: true });
    await writeFile(join(root, 'tests', 'unit', 'extension.test.ts'), "import test from 'node:test';\n\ntest('extension source is present', () => {});\n", { mode: 0o644 });
    await syncProjectTypes(root);
  }
  if (kind === 'resource' || kind === 'hybrid') await Promise.all([mkdir(join(root, 'content', 'decks'), { recursive: true }), mkdir(join(root, 'content', 'reply'), { recursive: true })]);
  await mkdir(join(root, 'assets'), { recursive: true });
  if (!argumentsList.includes('--no-sync')) await coreSync(root, { offline: argumentsList.includes('--offline') });
  output(options, `Created sealpack-only ${kind} project at ${root}`);
}

async function stageArchive(projectRoot: string) {
  const config = await loadProjectConfig(projectRoot);
  const staged = await stageSealpack({ root: projectRoot, config, target: '1.6.0' });
  const directory = join(projectRoot, '.seal', 'stage');
  await mkdir(directory, { recursive: true });
  const archive = join(directory, packageFileName(staged));
  await archiveSealpack(staged, archive);
  return { config, staged, archive };
}

function printDiagnostics(options: CliOptions, result: any) {
  for (const diagnostic of result.diagnostics ?? []) output(options, `${diagnostic.severity.toUpperCase()} ${diagnostic.ruleId}${diagnostic.path ? ` ${diagnostic.path}` : ''}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column || 1}` : ''} ${diagnostic.message}`);
}

async function resourceCheck(projectRoot: string, options: CliOptions, argumentsList: string[] = []) {
  const target = (await loadSealLock(projectRoot, toolRoot)).targets['1.6.0'];
  const verified = await coreVerify(projectRoot);
  const prepared = await stageArchive(projectRoot);
  const result = await invokeBridge({ worktree: verified.worktree, target, operation: 'check', archive: prepared.archive });
  printDiagnostics(options, result);
  const sarif = option(argumentsList, '--sarif');
  if (sarif) {
    if (sarif.includes('..') || sarif.startsWith('/')) throw new SealwrapperError('--sarif must be a project-relative path', 2);
    const path = join(projectRoot, sarif);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(toSarif(result.diagnostics ?? []), null, 2)}\n`, { mode: 0o644 });
    output(options, `SARIF: ${path}`);
  }
  if (!result.ok) throw new SealwrapperError('Resource check failed', 1);
  output(options, `Resource check passed for ${basename(prepared.archive)}`);
  return { ...prepared, target, verified, result };
}

async function smoke(projectRoot: string, options: CliOptions) {
  const checked = await resourceCheck(projectRoot, options);
  const result = await invokeBridge({ worktree: checked.verified.worktree, target: checked.target, operation: 'smoke', archive: checked.archive });
  if (!result.ok || !result.install?.installed || !result.install?.enabled || !result.install?.reloaded) throw new SealwrapperError('Install → Enable → Reload smoke failed', 1);
  output(options, 'Install → Enable → Reload smoke passed');
}

/** A deliberately small local-development helper: it rebuilds staging only.
 * It never contacts a host, uploads a package, or changes a managed core. */
async function watchProject(projectRoot: string, options: CliOptions, argumentsList: string[]) {
  const config = await loadProjectConfig(projectRoot);
  if (!config.build) throw new SealwrapperError('watch is available only to projects with a build entry', 2);
  const rebuild = async () => {
    const staged = await stageArchive(projectRoot);
    output(options, `Watch build ready: ${staged.archive}`);
  };
  await rebuild();
  if (argumentsList.includes('--once')) return;
  output(options, 'Watching src/; press Ctrl-C to stop. This does not reload a SealDice host.');
  await new Promise<void>((resolvePromise, reject) => {
    let busy = false;
    const watcher = watchFs(join(projectRoot, 'src'), { recursive: true }, () => {
      if (busy) return;
      busy = true;
      void rebuild().catch((error) => output(options, `Watch build failed: ${(error as Error).message}`)).finally(() => { busy = false; });
    });
    watcher.once('error', reject);
    process.once('SIGINT', () => { watcher.close(); resolvePromise(); });
  });
}

async function scenarioFiles(projectRoot: string): Promise<string[]> {
  const directory = join(projectRoot, 'tests', 'scenarios');
  let entries: any[];
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { throw new SealwrapperError('No scenario files found under tests/scenarios', 2); }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => join(directory, entry.name)).sort();
}

async function scenarioTest(argumentsList: string[], projectRoot: string, options: CliOptions) {
  const render = argumentsList.includes('--render');
  const png = argumentsList.includes('--png');
  const identity = option(argumentsList, '--identity') ?? 'qq-public';
  const theme = option(argumentsList, '--theme') ?? 'light';
  const style = option(argumentsList, '--style') ?? 'comfortable';
  const showMembers = argumentsList.includes('--members');
  if (!['light', 'dark', 'classic'].includes(theme)) throw new SealwrapperError('--theme must be light, dark, or classic', 2);
  if (!['comfortable', 'compact'].includes(style)) throw new SealwrapperError('--style must be comfortable or compact', 2);
  if (png && !render) throw new SealwrapperError('--png requires --render', 2);
  if (argumentsList.includes('--snapshot') && argumentsList.includes('--update-snapshots')) throw new SealwrapperError('--snapshot and --update-snapshots cannot be combined', 2);
  if (identity !== 'qq-public') throw new SealwrapperError('Only --identity qq-public is supported', 2);
  const checked = await resourceCheck(projectRoot, options);
  const files = await scenarioFiles(projectRoot);
  const releaseOnly = argumentsList.includes('--release');
  let executed = 0;
  for (const file of files) {
    const scenario = normalizeScenario(JSON.parse(await readFile(file, 'utf8')));
    if (releaseOnly && !scenario.release) continue;
    executed += 1;
    const archives = (scenario.packages ?? []).map((item: string) => {
      const archive = resolve(projectRoot, item);
      if (!archive.startsWith(`${resolve(projectRoot)}/`)) throw new SealwrapperError(`Scenario package escapes project root: ${item}`, 2);
      return archive;
    });
    for (const archive of archives) if (!(await exists(archive))) throw new SealwrapperError(`Scenario package does not exist: ${archive}`, 2);
    const result = await invokeBridge({ worktree: checked.verified.worktree, target: checked.target, operation: 'scenario', archive: checked.archive, archives, scenario });
    const expectsDiagnostics = scenario.expect?.diagnostics !== undefined;
    if (!result.ok && !expectsDiagnostics) {
      printDiagnostics(options, result);
      throw new SealwrapperError(`Scenario bridge failed: ${basename(file)}`, 1);
    }
    assertTranscriptExpectation(result.transcript ?? { messages: [] }, scenario.expect, result.diagnostics ?? []);
    if (scenario.expect?.random?.repeatable === true) {
      const repeated = await invokeBridge({ worktree: checked.verified.worktree, target: checked.target, operation: 'scenario', archive: checked.archive, archives, scenario });
      if (!repeated.ok || JSON.stringify(repeated.transcript) !== JSON.stringify(result.transcript)) throw new SealwrapperError(`Scenario seeded-random transcript is not repeatable: ${basename(file)}`, 1);
    }
    const snapshot = `${file}.snapshot.json`;
    if (argumentsList.includes('--update-snapshots')) {
      if (!result.transcript) throw new SealwrapperError(`Cannot snapshot diagnostics-only scenario: ${basename(file)}`, 2);
      await writeFile(snapshot, `${JSON.stringify(result.transcript, null, 2)}\n`, { mode: 0o644 });
    }
    else if (argumentsList.includes('--snapshot')) {
      if (!(await exists(snapshot))) throw new SealwrapperError(`Scenario snapshot does not exist: ${snapshot}; pass --update-snapshots to create it`, 2);
      if (!result.transcript) throw new SealwrapperError(`Cannot compare a snapshot for diagnostics-only scenario: ${basename(file)}`, 2);
      assertTranscriptExpectation(result.transcript, { transcript: JSON.parse(await readFile(snapshot, 'utf8')) });
    }
    output(options, `Scenario passed: ${basename(file)}`);
    if (render && result.transcript) {
      const report = await writeScenarioReport({ projectRoot, name: basename(file, '.json'), transcript: result.transcript, offline: argumentsList.includes('--offline'), refreshIdentities: argumentsList.includes('--refresh-identities'), theme: theme as 'light' | 'dark' | 'classic', style: style as 'comfortable' | 'compact', showMembers, png });
      for (const warning of report.warnings) output(options, `IDENTITY WARNING ${warning}`);
      output(options, `Report: ${report.json}, ${report.svg}, ${report.html}${report.png ? `, ${report.png}` : ''}`);
    }
  }
  if (releaseOnly && executed === 0) throw new SealwrapperError('No release-marked scenario files found', 2);
}

function artifactViolations(files: { path: string }[], policy: any): string[] {
  const forbidden = new Set(policy.forbiddenExtensions);
  return files.filter((file) => forbidden.has(file.path.slice(file.path.lastIndexOf('.')).toLowerCase()) || policy.forbiddenPaths.includes(file.path)).map((file) => file.path);
}

async function packageProject(projectRoot: string, options: CliOptions, argumentsList: string[] = []) {
  const projectConfig = await loadProjectConfig(projectRoot);
  if (projectConfig.build) await typecheckProject(projectRoot);
  await runJsReleaseQualityGate(projectRoot, projectConfig);
  const checked = await resourceCheck(projectRoot, options, argumentsList);
  const smokeResult = await invokeBridge({ worktree: checked.verified.worktree, target: checked.target, operation: 'smoke', archive: checked.archive });
  if (!smokeResult.ok || !smokeResult.install?.installed || !smokeResult.install?.enabled || !smokeResult.install?.reloaded) throw new SealwrapperError('Release gate Install → Enable → Reload smoke failed', 1);
  const violations = artifactViolations(checked.staged.files, checked.config.release.artifactPolicy);
  if (violations.length) throw new SealwrapperError(`Release artifact policy rejected: ${violations.join(', ')}`, 1);
  const release = join(projectRoot, checked.config.release.directory);
  const artifactName = packageFileName(checked.staged);
  const signKey = option(argumentsList, '--sign-key');
  const signKeyId = option(argumentsList, '--sign-key-id');
  if (signKeyId && !signKey) throw new SealwrapperError('--sign-key-id requires --sign-key', 2);
  let signingKeyPath: string | undefined;
  if (signKey) {
    signingKeyPath = resolve(projectRoot, signKey);
    if (!signingKeyPath.startsWith(`${resolve(projectRoot)}/`)) throw new SealwrapperError('--sign-key must be project-relative', 2);
    if (!(await exists(signingKeyPath))) throw new SealwrapperError(`--sign-key does not exist: ${signKey}`, 2);
  }
  // All irreversible release files remain in .seal until the archive,
  // checksum, provenance and optional signature have been produced.
  const temporaryRoot = await mkdtemp(join(projectRoot, '.seal', 'release-'));
  try {
    const artifact = join(temporaryRoot, artifactName);
    const checksum = `${artifact}.sha256`;
    const provenance = `${artifact}.release.json`;
    await archiveSealpack(checked.staged, artifact); // only after the real-core gate succeeds
    const digest = createHash('sha256').update(await readFile(artifact)).digest('hex');
    await writeFile(checksum, `${digest}  ${artifactName}\n`, { mode: 0o644 });
    // Rendering validates a supplied private key before release/ is touched.
    await writeFile(provenance, await renderReleaseProvenance({ projectRoot, artifact, config: checked.config, target: checked.target, signingKeyPath, signingKeyId: signKeyId ?? undefined }), { mode: 0o644 });
    const published = await publishReleaseFiles({ releaseDirectory: release, files: [
      { source: artifact, name: artifactName },
      { source: checksum, name: `${artifactName}.sha256` },
      { source: provenance, name: `${artifactName}.release.json` },
    ] });
    output(options, `Release provenance: ${published[2]}`);
    output(options, `Published ${published[0]}`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function doctor(projectRoot: string, options: CliOptions) {
  const lock = await loadSealLock(projectRoot, toolRoot);
  let git = '';
  try { git = (await execFileAsync('git', ['--version'])).stdout.trim(); } catch { throw new SealwrapperError('Git is required by seal.lock to prepare the managed core mirror', 2); }
  let go = '';
  try { go = (await execFileAsync('go', ['version'])).stdout.trim(); } catch { /* rendered below as unavailable */ }
  const expected = lock.targets['1.6.0'].testOverlay.goVersion;
  if (!go.includes(`go${expected} `)) throw new SealwrapperError(`Go ${expected} required by seal.lock; found ${go || 'unavailable'}`, 2);
  output(options, `Node ${process.versions.node}; Git ${git}; Go ${go}; target 1.6.0`);
}

const usage = 'Usage: sealwrapper|sealw <init|doctor|core|resource|types|typecheck|test|scenario|watch|package|lock> ...';

export async function runCli(argumentsList: string[], options: CliOptions) {
  const [command, subcommand] = argumentsList;
  if (!command || command === 'help' || command === '--help') { output(options, usage); return; }
  if (command === 'init') return initProject(argumentsList, options);
  if (argumentsList.includes('--core')) throw new SealwrapperError('sealwrapper never uses a user-supplied core checkout; use the lock-managed core sync', 2);
  targetFrom(argumentsList);
  if (command === 'doctor') return doctor(options.cwd, options);
  if (command === 'core' && subcommand === 'sync') { const result = await coreSync(options.cwd, { offline: argumentsList.includes('--offline') }); output(options, JSON.stringify(result)); return; }
  if (command === 'core' && subcommand === 'verify') { output(options, JSON.stringify(await coreVerify(options.cwd))); return; }
  if (command === 'types' && subcommand === 'sync') { const result = await syncProjectTypes(options.cwd); output(options, `Type contract synced: ${relative(options.cwd, result.path)} (${result.contractSha256})`); return; }
  if (command === 'types' && subcommand === 'verify') { const result = await verifyProjectTypes(options.cwd); output(options, `Type contract verified: ${relative(options.cwd, result.path)} (${result.contractSha256})`); return; }
  if (command === 'types' && subcommand === 'audit') {
    const verified = await coreVerify(options.cwd);
    const target = (await loadSealLock(options.cwd, toolRoot)).targets['1.6.0'];
    const audit = await auditApiContract(verified.worktree, target);
    if (audit.differences.length) throw new SealwrapperError(`Lock-managed core API differs from the checked-in contract:\n${audit.differences.join('\n')}`, 1);
    const reply = await auditReplyGrammar(verified.worktree);
    if (reply.differences.length) throw new SealwrapperError(`Lock-managed core reply grammar differs from the signed overlay:\n${reply.differences.join('\n')}`, 1);
    output(options, `API inventory matches managed core: ${audit.inventory.core.sourceFingerprint}`);
    output(options, `Reply grammar matches overlay: ${reply.grammar.production.condTypes.length} condition type(s), ${reply.grammar.production.resultTypes.length} result type(s)`);
    return;
  }
  if (command === 'types' && subcommand === 'update') {
    if (!argumentsList.includes('--write')) throw new SealwrapperError('types update writes sealwrapper-owned contract assets; pass --write after reviewing the managed core', 2);
    const verified = await coreVerify(options.cwd);
    const target = (await loadSealLock(options.cwd, toolRoot)).targets['1.6.0'];
    const updated = await updateApiContract(verified.worktree, target);
    output(options, `Updated API inventory: ${updated.inventory.core.sourceFingerprint}`);
    return;
  }
  if (command === 'typecheck') {
    const config = await loadProjectConfig(options.cwd);
    if (!config.build) throw new SealwrapperError('typecheck is available only to projects with a JS bundle', 2);
    const result = await typecheckProject(options.cwd);
    output(options, `Plugin TypeScript check passed: ${relative(options.cwd, result.path)}`);
    return;
  }
  if (command === 'resource' && subcommand === 'check') return resourceCheck(options.cwd, options, argumentsList);
  if (command === 'test') return smoke(options.cwd, options);
  if (command === 'scenario' && subcommand === 'test') return scenarioTest(argumentsList, options.cwd, options);
  if (command === 'watch') return watchProject(options.cwd, options, argumentsList);
  if (command === 'package') {
    if (argumentsList.includes('--format')) throw new SealwrapperError('sealwrapper is sealpack-only; package has no --format option', 2);
    return packageProject(options.cwd, options, argumentsList);
  }
  if (command === 'lock' && subcommand === 'update') {
    if (!argumentsList.includes('--allow-dirty')) {
      let status = '';
      try { status = (await execFileAsync('git', ['status', '--porcelain'], { cwd: options.cwd })).stdout; } catch { throw new SealwrapperError('lock update requires a Git worktree or explicit --allow-dirty', 2); }
      if (status.trim()) throw new SealwrapperError('lock update requires a clean Git worktree; pass --allow-dirty to confirm', 2);
    }
    const lockPath = join(options.cwd, 'seal.lock');
    let existing: unknown = {};
    try { existing = JSON.parse(await readFile(lockPath, 'utf8')); } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new SealwrapperError(`seal.lock is not valid JSON: ${error.message}`, 2);
    }
    const next = JSON.parse(renderSealLock(pinnedTarget));
    for (const line of describeLockDiff(existing, next)) output(options, line);
    const temporary = `${lockPath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 });
    await rename(temporary, lockPath);
    output(options, 'Updated seal.lock for exact target 1.6.0');
    return;
  }
  throw new SealwrapperError(`Unknown command. ${usage}`, 2);
}

if (import.meta.main) {
  runCli(process.argv.slice(2), { cwd: process.cwd() }).catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${detail}\n`);
    process.exitCode = error instanceof SealwrapperError ? error.exitCode : 3;
  });
}
