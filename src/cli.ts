import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { watch as watchFs } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  CommandLineAction,
  CommandLineParser,
} from '@rushstack/ts-command-line';

import { archiveSealpack } from './archive.ts';
import { auditApiContract, updateApiContract } from './api-contract.ts';
import { invokeBridge } from './bridge.ts';
import { configuredDefaultTarget, configuredTargetIds, loadProjectConfig } from './config.ts';
import { coreSync, coreVerify } from './core.ts';
import { SealwrapperError } from './errors.ts';
import { describeLockDiff, loadSealLock, lockedTarget, lockTargetIds, renderSealLock } from './lock.ts';
import { defaultTargetId, getTarget, minimumTargetId, targetIds } from './pinned-target.ts';
import { publishReleaseFiles, renderReleaseProvenance } from './release.ts';
import { auditReplyGrammar } from './reply-audit.ts';
import { writeScenarioReport } from './reports.ts';
import { runJsReleaseQualityGate } from './quality.ts';
import { assertTranscriptExpectation, normalizeScenario } from './scenario.ts';
import { toSarif } from './sarif.ts';
import { stageSealpack } from './stage.ts';
import { syncProjectTypes, typecheckProject, verifyProjectTypes } from './types.ts';
import { createProgress, type ProgressReporter, withProgress } from './progress.ts';

export type CliOptions = { cwd: string; write?: (line: string) => void; progress?: ProgressReporter };
type InitKind = 'js' | 'resource' | 'hybrid';
type InitOptions = { kind: InitKind; noSync: boolean; offline: boolean; targetId?: string };
type ResourceCheckOptions = { sarif?: string };
type ScenarioOptions = {
  targetId?: string;
  render: boolean;
  png: boolean;
  identity: 'qq-public';
  theme: 'light' | 'dark' | 'classic';
  style: 'comfortable' | 'compact';
  showMembers: boolean;
  snapshot: boolean;
  updateSnapshots: boolean;
  release: boolean;
  offline: boolean;
  refreshIdentities: boolean;
};
type WatchOptions = { once: boolean; targetId?: string };
type PackageOptions = { signKey?: string; signKeyId?: string; targetIds?: string[] } & ResourceCheckOptions;
const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

function output(options: CliOptions, line: string) { (options.write ?? ((value) => process.stdout.write(`${value}\n`)))(line); }

function hasOption(argumentsList: string[], parameterLongName: string): boolean {
  return argumentsList.some((token) => token === parameterLongName || token.startsWith(`${parameterLongName}=`));
}

function packageFileName(staged: any) {
  return `${staged.packageId.split('/')[1]}@${staged.version}.sealpack`;
}

async function exists(path: string) { try { await access(path); return true; } catch { return false; } }

function defaultConfig(kind: string, selectedTarget = defaultTargetId) {
  const scripts = kind === 'js' || kind === 'hybrid';
  const resources = kind === 'resource' || kind === 'hybrid';
  const contents: any = {};
  if (scripts) contents.scripts = { bundle: true, path: 'scripts/example.js' };
  if (resources) { contents.decks = { source: 'content/decks' }; contents.reply = { source: 'content/reply' }; }
  return {
    schemaVersion: 2,
    package: { name: 'My SealDice Package', version: '0.1.0', authors: ['Your Name'], license: 'MIT', description: '', homepage: '' },
    ...(scripts ? { build: { entry: 'src/index.ts', ecmaTarget: 'es6', bundleFileName: 'example.js' } } : {}),
    sealDice: { buildTarget: [selectedTarget], defaultTarget: selectedTarget },
    release: { directory: 'release', checksum: 'sha256', artifactPolicy: { forbiddenPaths: [], forbiddenExtensions: [] } },
    sealpack: {
      packageId: 'author/my-package', minSealDice: minimumTargetId([selectedTarget]), contents, dependencies: {},
      permissions: { network: false, networkHosts: [], acknowledgeUnrestrictedNetwork: false, fileRead: [], fileWrite: [], dangerous: false, httpServer: false, ipc: [] },
      readme: 'README.md', assets: [], store: { category: 'rules', icon: '', banner: '', screenshots: [] },
    },
  };
}

function defaultTsConfig(targetIdsToInclude: readonly string[] = [defaultTargetId]) {
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
    include: ['src/**/*.ts', ...targetIdsToInclude.map((id) => `.seal/types/sealdice-${id}.d.ts`)],
  };
}

async function initProject(directory: string | undefined, options: CliOptions, initOptions: InitOptions) {
  if (!directory || directory.startsWith('--')) throw new SealwrapperError('init requires a destination directory', 2);
  const { kind } = initOptions;
  const selectedTarget = initOptions.targetId ?? defaultTargetId;
  const root = resolve(options.cwd, directory);
  if (await exists(root)) throw new SealwrapperError(`init destination already exists: ${root}`, 2);
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, 'seal.config.json'), `${JSON.stringify(defaultConfig(kind, selectedTarget), null, 2)}\n`, { mode: 0o644 }),
    writeFile(join(root, 'seal.lock'), renderSealLock(getTarget(selectedTarget)), { mode: 0o644 }),
    writeFile(join(root, 'README.md'), '# My SealDice Package\n', { mode: 0o644 }),
    writeFile(join(root, '.gitignore'), '.seal/\ndist/\nrelease/\n*.sealpack\n', { mode: 0o644 }),
    writeFile(join(root, 'sealw'), '#!/bin/sh\n# Uses the project-local, package-lock-pinned sealwrapper installation.\nexec npx --no-install sealwrapper "$@"\n', { mode: 0o755 }),
    ...((kind === 'js' || kind === 'hybrid') ? [writeFile(join(root, 'tsconfig.json'), `${JSON.stringify(defaultTsConfig([selectedTarget]), null, 2)}\n`, { mode: 0o644 })] : []),
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
  if (!initOptions.noSync) {
    await withProgress(options.progress, 'Synchronizing managed core', () => coreSync(root, { offline: initOptions.offline }), 'Managed core synchronized');
  }
  output(options, `Created sealpack-only ${kind} project at ${root}`);
}

async function stageArchive(projectRoot: string) {
  const config = await loadProjectConfig(projectRoot);
  const staged = await stageSealpack({ root: projectRoot, config });
  const directory = join(projectRoot, '.seal', 'stage');
  await mkdir(directory, { recursive: true });
  const archive = join(directory, packageFileName(staged));
  await archiveSealpack(staged, archive);
  return { config, staged, archive };
}

function printDiagnostics(options: CliOptions, result: any) {
  for (const diagnostic of result.diagnostics ?? []) output(options, `${diagnostic.severity.toUpperCase()} ${diagnostic.ruleId}${diagnostic.path ? ` ${diagnostic.path}` : ''}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column || 1}` : ''} ${diagnostic.message}`);
}

async function resourceCheck(projectRoot: string, options: CliOptions, checkOptions: ResourceCheckOptions = {}, targetId?: string, preparedInput?: Awaited<ReturnType<typeof stageArchive>>) {
  options.progress?.update(`Checking resource archive${targetId ? ` (${targetId})` : ''}`);
  const prepared = preparedInput ?? await stageArchive(projectRoot);
  const selectedTargetId = targetId ?? configuredDefaultTarget(prepared.config);
  if (!configuredTargetIds(prepared.config).includes(selectedTargetId)) throw new SealwrapperError(`Target ${selectedTargetId} is not selected by sealDice.buildTarget`, 2);
  const target = lockedTarget(await loadSealLock(projectRoot, toolRoot), selectedTargetId);
  const verified = await coreVerify(projectRoot, { targetId: selectedTargetId });
  const result = await invokeBridge({ worktree: verified.worktree, target, operation: 'check', archive: prepared.archive });
  printDiagnostics(options, result);
  const sarif = checkOptions.sarif;
  if (sarif) {
    if (sarif.includes('..') || sarif.startsWith('/')) throw new SealwrapperError('--sarif must be a project-relative path', 2);
    const path = join(projectRoot, sarif);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(toSarif(result.diagnostics ?? []), null, 2)}\n`, { mode: 0o644 });
    output(options, `SARIF: ${path}`);
  }
  if (!result.ok) throw new SealwrapperError('Resource check failed', 1);
  output(options, `Resource check passed for ${basename(prepared.archive)} (${selectedTargetId})`);
  return { ...prepared, targetId: selectedTargetId, target, verified, result };
}

async function smoke(projectRoot: string, options: CliOptions, targetId?: string) {
  options.progress?.update('Checking resources');
  const checked = await resourceCheck(projectRoot, options, {}, targetId);
  options.progress?.update('Running Install → Enable → Reload smoke');
  const result = await invokeBridge({ worktree: checked.verified.worktree, target: checked.target, operation: 'smoke', archive: checked.archive });
  if (!result.ok || !result.install?.installed || !result.install?.enabled || !result.install?.reloaded) throw new SealwrapperError('Install → Enable → Reload smoke failed', 1);
  output(options, 'Install → Enable → Reload smoke passed');
}

/** A deliberately small local-development helper: it rebuilds staging only.
 * It never contacts a host, uploads a package, or changes a managed core. */
async function watchProject(projectRoot: string, options: CliOptions, watchOptions: WatchOptions) {
  const config = await loadProjectConfig(projectRoot);
  if (!config.build) throw new SealwrapperError('watch is available only to projects with a build entry', 2);
  if (watchOptions.targetId && !configuredTargetIds(config).includes(watchOptions.targetId)) throw new SealwrapperError(`Target ${watchOptions.targetId} is not selected by sealDice.buildTarget`, 2);
  const rebuild = async () => {
    const staged = await stageArchive(projectRoot);
    output(options, `Watch build ready: ${staged.archive}`);
  };
  await rebuild();
  if (watchOptions.once) return;
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
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => join(directory, entry.name)).sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
  if (files.length === 0) throw new SealwrapperError('No scenario files found under tests/scenarios', 2);
  return files;
}

async function scenarioTest(projectRoot: string, options: CliOptions, scenarioOptions: ScenarioOptions) {
  const { targetId, render, png, identity, theme, style, showMembers, snapshot: compareSnapshots, updateSnapshots, release: releaseOnly, offline, refreshIdentities } = scenarioOptions;
  if (png && !render) throw new SealwrapperError('--png requires --render', 2);
  if (compareSnapshots && updateSnapshots) throw new SealwrapperError('--snapshot and --update-snapshots cannot be combined', 2);
  if (identity !== 'qq-public') throw new SealwrapperError('Only --identity qq-public is supported', 2);
  const files = await scenarioFiles(projectRoot);
  const config = await loadProjectConfig(projectRoot);
  const selectedTargets = targetId ? [targetId] : configuredTargetIds(config);
  const prepared = await stageArchive(projectRoot);
  let executed = 0;
  for (const selectedTargetId of selectedTargets) {
    const checked = await resourceCheck(projectRoot, options, {}, selectedTargetId, prepared);
    for (const file of files) {
      options.progress?.update(`Running scenario ${basename(file)} (${selectedTargetId})`);
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
        throw new SealwrapperError(`Scenario bridge failed: ${basename(file)} (${selectedTargetId})`, 1);
      }
      assertTranscriptExpectation(result.transcript ?? { messages: [] }, scenario.expect, result.diagnostics ?? []);
      if (scenario.expect?.random?.repeatable === true) {
        const repeated = await invokeBridge({ worktree: checked.verified.worktree, target: checked.target, operation: 'scenario', archive: checked.archive, archives, scenario });
        if (!repeated.ok || JSON.stringify(repeated.transcript) !== JSON.stringify(result.transcript)) throw new SealwrapperError(`Scenario seeded-random transcript is not repeatable: ${basename(file)} (${selectedTargetId})`, 1);
      }
      const snapshotPath = selectedTargets.length === 1 ? `${file}.snapshot.json` : `${file}.${selectedTargetId}.snapshot.json`;
      if (updateSnapshots) {
        if (!result.transcript) throw new SealwrapperError(`Cannot snapshot diagnostics-only scenario: ${basename(file)}`, 2);
        await writeFile(snapshotPath, `${JSON.stringify(result.transcript, null, 2)}\n`, { mode: 0o644 });
      }
      else if (compareSnapshots) {
        if (!(await exists(snapshotPath))) throw new SealwrapperError(`Scenario snapshot does not exist: ${snapshotPath}; pass --update-snapshots to create it`, 2);
        if (!result.transcript) throw new SealwrapperError(`Cannot compare a snapshot for diagnostics-only scenario: ${basename(file)}`, 2);
        assertTranscriptExpectation(result.transcript, { transcript: JSON.parse(await readFile(snapshotPath, 'utf8')) });
      }
      output(options, `Scenario passed: ${basename(file)} (${selectedTargetId})`);
      if (render && result.transcript) {
        const reportName = selectedTargets.length === 1 ? basename(file, '.json') : `${basename(file, '.json')}-${selectedTargetId}`;
        const report = await writeScenarioReport({ projectRoot, name: reportName, transcript: result.transcript, offline, refreshIdentities, theme, style, showMembers, png });
        for (const warning of report.warnings) output(options, `IDENTITY WARNING ${warning}`);
        output(options, `Report: ${report.json}, ${report.svg}, ${report.html}${report.png ? `, ${report.png}` : ''}`);
      }
    }
  }
  if (executed === 0) {
    if (releaseOnly) throw new SealwrapperError('No release-marked scenario files found', 2);
    throw new SealwrapperError('No scenario files were executed', 2);
  }
}

function artifactViolations(files: { path: string }[], policy: any): string[] {
  const forbidden = new Set(policy.forbiddenExtensions);
  return files.filter((file) => forbidden.has(file.path.slice(file.path.lastIndexOf('.')).toLowerCase()) || policy.forbiddenPaths.includes(file.path)).map((file) => file.path);
}

async function packageProject(projectRoot: string, options: CliOptions, packageOptions: PackageOptions = {}) {
  options.progress?.update('Preparing release gates');
  const projectConfig = await loadProjectConfig(projectRoot);
  const selectedTargets = packageOptions.targetIds ?? configuredTargetIds(projectConfig);
  if (selectedTargets.length === 0) throw new SealwrapperError('No build targets are configured', 2);
  for (const id of selectedTargets) if (!configuredTargetIds(projectConfig).includes(id)) throw new SealwrapperError(`Target ${id} is not selected by sealDice.buildTarget`, 2);
  if (projectConfig.build) for (const id of selectedTargets) {
    const result = await typecheckProject(projectRoot, id);
    output(options, `Plugin TypeScript check passed: ${id} (${relative(projectRoot, result.path)})`);
  }
  await runJsReleaseQualityGate(projectRoot, projectConfig);
  const prepared = await stageArchive(projectRoot);
  const checkedTargets: Awaited<ReturnType<typeof resourceCheck>>[] = [];
  for (const id of selectedTargets) {
    const checked = await resourceCheck(projectRoot, options, {}, id, prepared);
    options.progress?.update(`Running release smoke test (${id})`);
    const smokeResult = await invokeBridge({ worktree: checked.verified.worktree, target: checked.target, operation: 'smoke', archive: checked.archive });
    if (!smokeResult.ok || !smokeResult.install?.installed || !smokeResult.install?.enabled || !smokeResult.install?.reloaded) throw new SealwrapperError(`Release gate Install → Enable → Reload smoke failed for ${id}`, 1);
    checkedTargets.push(checked);
  }
  const violations = artifactViolations(prepared.staged.files, prepared.config.release.artifactPolicy);
  if (violations.length) throw new SealwrapperError(`Release artifact policy rejected: ${violations.join(', ')}`, 1);
  const release = join(projectRoot, prepared.config.release.directory);
  const artifactName = packageFileName(prepared.staged);
  const signKey = packageOptions.signKey;
  const signKeyId = packageOptions.signKeyId;
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
    await archiveSealpack(prepared.staged, artifact); // only after every selected real-core gate succeeds
    const digest = createHash('sha256').update(await readFile(artifact)).digest('hex');
    await writeFile(checksum, `${digest}  ${artifactName}\n`, { mode: 0o644 });
    // Rendering validates a supplied private key before release/ is touched.
    await writeFile(provenance, await renderReleaseProvenance({ projectRoot, artifact, config: prepared.config, targets: checkedTargets.map((checked) => checked.target), signingKeyPath, signingKeyId: signKeyId ?? undefined }), { mode: 0o644 });
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

async function doctor(projectRoot: string, options: CliOptions, targetId?: string) {
  const lock = await loadSealLock(projectRoot, toolRoot);
  let git = '';
  try { git = (await execFileAsync('git', ['--version'])).stdout.trim(); } catch { throw new SealwrapperError('Git is required by seal.lock to prepare the managed core mirror', 2); }
  let go = '';
  try { go = (await execFileAsync('go', ['version'])).stdout.trim(); } catch { /* rendered below as unavailable */ }
  const selected = targetId ? [targetId] : lockTargetIds(lock);
  const expected = [...new Set(selected.map((id) => lockedTarget(lock, id).testOverlay.goVersion))];
  for (const version of expected) if (!go.includes(`go${version} `)) throw new SealwrapperError(`Go ${version} required by seal.lock; found ${go || 'unavailable'}`, 2);
  output(options, `Node ${process.versions.node}; Git ${git}; Go ${go}; targets ${selected.join(', ')}`);
}

type ActionHandler = () => Promise<unknown>;

/** A small adapter that keeps the command definitions declarative while the
 * existing domain functions remain ordinary, independently testable functions. */
class CallbackAction extends CommandLineAction {
  private handler: ActionHandler | undefined;
  result: unknown = undefined;

  constructor(actionName: string, summary: string, documentation: string) {
    super({ actionName, summary, documentation });
  }

  setHandler(handler: ActionHandler): this {
    this.handler = handler;
    return this;
  }

  protected override async onExecuteAsync(): Promise<void> {
    if (!this.handler) throw new Error(`No handler was registered for ${this.actionName}`);
    this.result = await this.handler();
  }
}

function defineTarget(action: CommandLineAction) {
  return action.defineChoiceParameter<string>({
    parameterLongName: '--target',
    description: 'Select one registered SealDice target. Matrix gates use all configured targets when omitted; single-target commands use the configured default.',
    alternatives: targetIds(),
  });
}

function makeInitAction(options: CliOptions): CallbackAction {
  const action = new CallbackAction('init', 'Create a new sealpack project.', 'Create a schema-v2 sealpack project with a lock-managed target set.');
  const target = defineTarget(action);
  const kind = action.defineChoiceParameter<'js' | 'resource' | 'hybrid'>({
    parameterLongName: '--kind',
    description: 'Project contents to scaffold.',
    alternatives: ['js', 'resource', 'hybrid'],
    defaultValue: 'hybrid',
  });
  const noSync = action.defineFlagParameter({ parameterLongName: '--no-sync', description: 'Do not prepare the managed core after scaffolding.' });
  const offline = action.defineFlagParameter({ parameterLongName: '--offline', description: 'Use only an already cached managed core.' });
  const remainder = action.defineCommandLineRemainder({ description: 'The destination directory.' });
  return action.setHandler(async () => {
    if (remainder.values.length !== 1) throw new SealwrapperError('init requires exactly one destination directory', 2);
    await initProject(remainder.values[0], options, { kind: kind.value ?? 'hybrid', noSync: noSync.value, offline: offline.value, targetId: target.value });
  });
}

function makeDoctorAction(options: CliOptions): CallbackAction {
  const action = new CallbackAction('doctor', 'Check local toolchain prerequisites.', 'Verify Git, the lock-pinned Go toolchains and selected targets.');
  const target = defineTarget(action);
  return action.setHandler(() => doctor(options.cwd, options, target.value));
}

function makeCoreSyncAction(options: CliOptions): CallbackAction {
  const action = new CallbackAction('core:sync', 'Prepare the lock-managed core.', 'Clone or refresh the signed mirror, apply the test-only overlay and build the detached worktree.');
  const target = defineTarget(action);
  const offline = action.defineFlagParameter({ parameterLongName: '--offline', description: 'Use only an already cached managed core.' });
  return action.setHandler(async () => {
    await withProgress(options.progress, 'Synchronizing managed core', async () => {
      const result = await coreSync(options.cwd, { targetId: target.value, offline: offline.value });
      output(options, JSON.stringify(result));
    }, 'Managed core synchronized');
  });
}

function makeCoreVerifyAction(options: CliOptions): CallbackAction {
  const action = new CallbackAction('core:verify', 'Verify the managed core.', 'Verify the lock-owned mirror, detached worktree and test-only overlay.');
  const target = defineTarget(action);
  return action.setHandler(async () => {
    await withProgress(options.progress, 'Verifying managed core', async () => {
      output(options, JSON.stringify(await coreVerify(options.cwd, { targetId: target.value })));
    }, 'Managed core verified');
  });
}

function makeTypesSyncAction(options: CliOptions): CallbackAction {
  const action = new CallbackAction('types:sync', 'Refresh a target TypeScript declaration.', 'Generate the managed SealDice declaration used by plugin typechecking.');
  const target = defineTarget(action);
  return action.setHandler(async () => {
    const result = await syncProjectTypes(options.cwd, target.value);
    output(options, `Type contract synced: ${relative(options.cwd, result.path)} (${result.contractSha256})`);
  });
}

function makeTypesVerifyAction(options: CliOptions): CallbackAction {
  const action = new CallbackAction('types:verify', 'Verify the generated TypeScript declaration.', 'Ensure the managed target declaration has not been edited or gone stale.');
  const target = defineTarget(action);
  return action.setHandler(async () => {
    const result = await verifyProjectTypes(options.cwd, target.value);
    output(options, `Type contract verified: ${relative(options.cwd, result.path)} (${result.contractSha256})`);
  });
}

function makeTypesAuditAction(options: CliOptions): CallbackAction {
  const action = new CallbackAction('types:audit', 'Audit the managed core API contract.', 'Rescan the managed core and compare its API inventory and reply grammar with the checked-in contract.');
  const targetParameter = defineTarget(action);
  return action.setHandler(async () => {
    await withProgress(options.progress, 'Auditing managed core API contract', async () => {
      const verified = await coreVerify(options.cwd, { targetId: targetParameter.value });
      const target = lockedTarget(await loadSealLock(options.cwd, toolRoot), verified.target);
      const audit = await auditApiContract(verified.worktree, target);
      if (audit.differences.length) throw new SealwrapperError(`Lock-managed core API differs from the checked-in contract:\n${audit.differences.join('\n')}`, 1);
      const reply = await auditReplyGrammar(verified.worktree, target);
      if (reply.differences.length) throw new SealwrapperError(`Lock-managed core reply grammar differs from the signed overlay:\n${reply.differences.join('\n')}`, 1);
      output(options, `API inventory matches managed core: ${audit.inventory.core.sourceFingerprint}`);
      output(options, `Reply grammar matches overlay: ${reply.grammar.production.condTypes.length} condition type(s), ${reply.grammar.production.resultTypes.length} result type(s)`);
    }, 'Managed core API contract matches');
  });
}

function makeTypesUpdateAction(options: CliOptions): CallbackAction {
  const action = new CallbackAction('types:update', 'Update the checked-in API contract.', 'Rewrite sealwrapper-owned API contract assets after reviewing a managed-core API change.');
  const targetParameter = defineTarget(action);
  const write = action.defineFlagParameter({ parameterLongName: '--write', description: 'Acknowledge that the checked-in contract will be rewritten.' });
  return action.setHandler(async () => {
    if (!write.value) throw new SealwrapperError('types update writes sealwrapper-owned contract assets; pass --write after reviewing the managed core', 2);
    await withProgress(options.progress, 'Updating API contract', async () => {
      const verified = await coreVerify(options.cwd, { targetId: targetParameter.value });
      const target = lockedTarget(await loadSealLock(options.cwd, toolRoot), verified.target);
      const updated = await updateApiContract(verified.worktree, target);
      output(options, `Updated API inventory: ${updated.inventory.core.sourceFingerprint}`);
    }, 'API contract updated');
  });
}

function makeTypecheckAction(options: CliOptions): CallbackAction {
  const action = new CallbackAction('typecheck', 'Typecheck a JavaScript-bearing project.', 'Check src/ against the selected SealDice declaration without emitting JavaScript.');
  const target = defineTarget(action);
  return action.setHandler(async () => {
    const config = await loadProjectConfig(options.cwd);
    if (!config.build) throw new SealwrapperError('typecheck is available only to projects with a JS bundle', 2);
    const result = await typecheckProject(options.cwd, target.value);
    output(options, `Plugin TypeScript check passed: ${relative(options.cwd, result.path)}`);
  });
}

function makeResourceCheckAction(options: CliOptions): CallbackAction {
  const action = new CallbackAction('resource:check', 'Validate staged resources with the managed core.', 'Run strict resource validation and optionally write a SARIF report.');
  const target = defineTarget(action);
  const sarif = action.defineStringParameter({ parameterLongName: '--sarif', argumentName: 'PATH', description: 'Write diagnostics as a project-relative SARIF file.' });
  return action.setHandler(async () => {
    const config = await loadProjectConfig(options.cwd);
    const selectedTargets = target.value ? [target.value] : configuredTargetIds(config);
    const prepared = await stageArchive(options.cwd);
    await withProgress(options.progress, 'Checking resource archive', async () => {
      for (const selectedTarget of selectedTargets) {
        const sarifPath = sarif.value && selectedTargets.length > 1
          ? sarif.value.replace(/(\.sarif)?$/u, `.${selectedTarget}$1`)
          : sarif.value;
        await resourceCheck(options.cwd, options, { sarif: sarifPath }, selectedTarget, prepared);
      }
    }, 'Resource check passed');
  });
}

function makeTestAction(options: CliOptions): CallbackAction {
  const action = new CallbackAction('test', 'Run the Install → Enable → Reload smoke test.', 'Validate resources and exercise installation, enabling and reload through the managed bridge.');
  const target = defineTarget(action);
  return action.setHandler(async () => {
    const config = await loadProjectConfig(options.cwd);
    const selectedTargets = target.value ? [target.value] : configuredTargetIds(config);
    await withProgress(options.progress, 'Running smoke test', async () => {
      for (const selectedTarget of selectedTargets) await smoke(options.cwd, options, selectedTarget);
    }, 'Smoke test passed');
  });
}

function makeScenarioAction(options: CliOptions): CallbackAction {
  const action = new CallbackAction('scenario:test', 'Execute deterministic fake-QQ scenarios.', 'Run scenario transcripts, snapshots and optional offline reports through the managed bridge.');
  const target = defineTarget(action);
  const render = action.defineFlagParameter({ parameterLongName: '--render', description: 'Write JSON, SVG and HTML diagnostic reports.' });
  const png = action.defineFlagParameter({ parameterLongName: '--png', description: 'Also rasterize the rendered report to PNG.' });
  const identity = action.defineChoiceParameter<'qq-public'>({ parameterLongName: '--identity', description: 'Identity provider for rendered reports.', alternatives: ['qq-public'], defaultValue: 'qq-public' });
  const theme = action.defineChoiceParameter<'light' | 'dark' | 'classic'>({ parameterLongName: '--theme', description: 'Rendered report theme.', alternatives: ['light', 'dark', 'classic'], defaultValue: 'light' });
  const style = action.defineChoiceParameter<'comfortable' | 'compact'>({ parameterLongName: '--style', description: 'Rendered report density.', alternatives: ['comfortable', 'compact'], defaultValue: 'comfortable' });
  const members = action.defineFlagParameter({ parameterLongName: '--members', description: 'Show group members in rendered reports.' });
  const snapshot = action.defineFlagParameter({ parameterLongName: '--snapshot', description: 'Compare each transcript with its snapshot.' });
  const updateSnapshots = action.defineFlagParameter({ parameterLongName: '--update-snapshots', description: 'Rewrite each transcript snapshot.' });
  const release = action.defineFlagParameter({ parameterLongName: '--release', description: 'Run only scenarios marked for release.' });
  const offline = action.defineFlagParameter({ parameterLongName: '--offline', description: 'Resolve report identities from the local cache only.' });
  const refreshIdentities = action.defineFlagParameter({ parameterLongName: '--refresh-identities', description: 'Refresh cached report identities when online.' });
  return action.setHandler(async () => {
    await withProgress(options.progress, 'Running scenarios', () => scenarioTest(options.cwd, options, {
      targetId: target.value,
      render: render.value,
      png: png.value,
      identity: identity.value ?? 'qq-public',
      theme: theme.value ?? 'light',
      style: style.value ?? 'comfortable',
      showMembers: members.value,
      snapshot: snapshot.value,
      updateSnapshots: updateSnapshots.value,
      release: release.value,
      offline: offline.value,
      refreshIdentities: refreshIdentities.value,
    }), 'Scenarios passed');
  });
}

function makeWatchAction(options: CliOptions): CallbackAction {
  const action = new CallbackAction('watch', 'Watch and rebuild local JavaScript staging.', 'Rebuild staging on src/ changes. This never contacts or reloads a SealDice host.');
  const target = defineTarget(action);
  const once = action.defineFlagParameter({ parameterLongName: '--once', description: 'Build once and exit.' });
  return action.setHandler(async () => {
    await withProgress(options.progress, 'Watching source', () => watchProject(options.cwd, options, { once: once.value, targetId: target.value }), 'Watch stopped');
  });
}

function makePackageAction(options: CliOptions): CallbackAction {
  const action = new CallbackAction('package', 'Build and publish a release sealpack.', 'Run type, resource, host, artifact-policy and provenance gates before publishing a complete release set.');
  const target = defineTarget(action);
  const signKey = action.defineStringParameter({ parameterLongName: '--sign-key', argumentName: 'PATH', description: 'Project-relative Ed25519 private key for provenance signing.' });
  const signKeyId = action.defineStringParameter({ parameterLongName: '--sign-key-id', argumentName: 'ID', description: 'Key identifier recorded in signed provenance.' });
  return action.setHandler(async () => {
    await withProgress(options.progress, 'Packaging sealpack', () => packageProject(options.cwd, options, { signKey: signKey.value, signKeyId: signKeyId.value, targetIds: target.value ? [target.value] : undefined }), 'Sealpack published');
  });
}

async function updateLock(projectRoot: string, options: CliOptions, allowDirty: boolean, targetId?: string) {
  if (!allowDirty) {
    let status = '';
    try { status = (await execFileAsync('git', ['status', '--porcelain'], { cwd: projectRoot })).stdout; } catch { throw new SealwrapperError('lock update requires a Git worktree or explicit --allow-dirty', 2); }
    if (status.trim()) throw new SealwrapperError('lock update requires a clean Git worktree; pass --allow-dirty to confirm', 2);
  }
  const lockPath = join(projectRoot, 'seal.lock');
  let existing: unknown = {};
  try { existing = JSON.parse(await readFile(lockPath, 'utf8')); } catch (error: any) {
    if (error?.code !== 'ENOENT') throw new SealwrapperError(`seal.lock is not valid JSON: ${error.message}`, 2);
  }
  if (existing && typeof existing === 'object' && !Array.isArray(existing) && 'lockVersion' in existing && (existing as { lockVersion?: unknown }).lockVersion !== 2) {
    throw new SealwrapperError('seal.lock must use lockVersion: 2', 2);
  }
  let configuredTargets = [defaultTargetId];
  let configuredDefault = defaultTargetId;
  let hasConfig = false;
  try {
    const config = await loadProjectConfig(projectRoot);
    hasConfig = true;
    configuredTargets = configuredTargetIds(config);
    configuredDefault = configuredDefaultTarget(config);
  } catch (error) {
    if (!((error as any)?.code === 'ENOENT' || error instanceof SealwrapperError && /seal\.config\.json|ENOENT|no such file/i.test(error.message))) throw error;
  }
  const requested = targetId;
  if (requested && hasConfig && !configuredTargets.includes(requested)) throw new SealwrapperError(`Target ${requested} is not selected by sealDice.buildTarget`, 2);
  const selectedTargets = requested ? [requested] : configuredTargets;
  const targetMap = Object.fromEntries(selectedTargets.map((id) => [id, getTarget(id)]));
  const next = JSON.parse(renderSealLock(targetMap, selectedTargets, selectedTargets.includes(configuredDefault) ? configuredDefault : selectedTargets[0]));
  for (const line of describeLockDiff(existing, next)) output(options, line);
  const temporary = `${lockPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 });
  await rename(temporary, lockPath);
  output(options, `Updated seal.lock for target set: ${selectedTargets.join(', ')}`);
}

function makeLockUpdateAction(options: CliOptions): CallbackAction {
  const action = new CallbackAction('lock:update', 'Update the project lock descriptor.', 'Refresh seal.lock for the configured target set, requiring a clean worktree unless explicitly overridden.');
  const target = defineTarget(action);
  const allowDirty = action.defineFlagParameter({ parameterLongName: '--allow-dirty', description: 'Allow lock updates in a dirty Git worktree.' });
  return action.setHandler(() => updateLock(options.cwd, options, allowDirty.value, target.value));
}

const groupedCommands: Readonly<Record<string, string>> = {
  'core sync': 'core:sync',
  'core verify': 'core:verify',
  'types sync': 'types:sync',
  'types verify': 'types:verify',
  'types audit': 'types:audit',
  'types update': 'types:update',
  'resource check': 'resource:check',
  'scenario test': 'scenario:test',
  'lock update': 'lock:update',
};

const actionNames = new Set(['init', 'doctor', 'core:sync', 'core:verify', 'types:sync', 'types:verify', 'types:audit', 'types:update', 'typecheck', 'resource:check', 'test', 'scenario:test', 'watch', 'package', 'lock:update']);

/**
 * RushStack models actions as one token.  Normalize the historical two-token
 * spelling (`core sync`) to its canonical colon action while retaining the
 * public syntax used by existing projects and documentation.  We also move
 * the target option after the action (where action parameters belong)
 * and put init's remainder after its options, matching argparse's grammar.
 */
function normalizeArguments(argumentsList: string[]): string[] {
  let args = [...argumentsList];
  if (args[0] === 'help') {
    if (args.length === 1) return ['--help'];
    args = [...args.slice(1), '--help'];
  }

  let target: string[] | undefined;
  const withoutTarget: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const inlineTarget = token.startsWith('--target=') ? token.slice('--target='.length) : undefined;
    if (token !== '--target' && inlineTarget === undefined) {
      withoutTarget.push(token);
      continue;
    }
    if (target) throw new SealwrapperError('--target may only be specified once', 2);
    const value = inlineTarget ?? args[index + 1];
    if (!value || value.startsWith('--')) throw new SealwrapperError('--target requires a value', 2);
    target = ['--target', value];
    if (inlineTarget === undefined) index += 1;
  }
  args = withoutTarget;

  let actionIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '-h' || token === '--help') continue;
    if (!token.startsWith('-')) { actionIndex = index; break; }
  }
  if (actionIndex === -1) return args;

  const groupKey = `${args[actionIndex]} ${args[actionIndex + 1] ?? ''}`;
  const canonical = groupedCommands[groupKey];
  if (canonical) {
    args = [...args.slice(0, actionIndex), canonical, ...args.slice(actionIndex + 2)];
  }
  actionIndex = args.findIndex((token) => actionNames.has(token));
  if (actionIndex === -1) actionIndex = args.findIndex((token) => !token.startsWith('-'));
  if (actionIndex === -1) return args;
  if (target) args = [...args.slice(0, actionIndex + 1), ...target, ...args.slice(actionIndex + 1)];

  if (args[actionIndex] === 'init') {
    const prefix = args.slice(0, actionIndex + 1);
    const after = args.slice(actionIndex + 1);
    const parameters: string[] = [];
    const positional: string[] = [];
    const valueOptions = new Set(['--target', '--kind']);
    for (let index = 0; index < after.length; index += 1) {
      const token = after[index];
      if (valueOptions.has(token)) {
        parameters.push(token);
        if (after[index + 1] !== undefined) parameters.push(after[++index]);
      }
      else if (token.startsWith('-')) parameters.push(token);
      else positional.push(token);
    }
    return [...prefix, ...parameters, ...positional];
  }
  return args;
}

function stripAnsi(value: string): string {
  let clean = value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').replace(/^usage:/m, 'Usage:');
  for (const [legacy, canonical] of Object.entries(groupedCommands)) clean = clean.replaceAll(canonical, legacy);
  return clean;
}

function printHelp(options: CliOptions, parser: CommandLineParser, actionName?: string) {
  const action = actionName ? parser.tryGetAction(actionName) : undefined;
  output(options, stripAnsi(action?.renderHelpText() ?? parser.renderHelpText()).trimEnd());
}

function createCommandLine(options: CliOptions): CommandLineParser {
  const parser = new CommandLineParser({
    toolFilename: 'sealwrapper|sealw',
    toolDescription: 'Sealpack-only SealDice extension development tools with a registry-backed target matrix.',
    toolEpilog: 'For detailed help about a specific command, use: sealw <command> -h',
  });
  parser.addAction(makeInitAction(options));
  parser.addAction(makeDoctorAction(options));
  parser.addAction(makeCoreSyncAction(options));
  parser.addAction(makeCoreVerifyAction(options));
  parser.addAction(makeTypesSyncAction(options));
  parser.addAction(makeTypesVerifyAction(options));
  parser.addAction(makeTypesAuditAction(options));
  parser.addAction(makeTypesUpdateAction(options));
  parser.addAction(makeTypecheckAction(options));
  parser.addAction(makeResourceCheckAction(options));
  parser.addAction(makeTestAction(options));
  parser.addAction(makeScenarioAction(options));
  parser.addAction(makeWatchAction(options));
  parser.addAction(makePackageAction(options));
  parser.addAction(makeLockUpdateAction(options));
  return parser;
}

function parserExitCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('exitCode' in error)) return undefined;
  const exitCode = (error as { exitCode?: unknown }).exitCode;
  return typeof exitCode === 'number' ? exitCode : undefined;
}

async function executeCommandLine(parser: CommandLineParser, argumentsList: string[], options: CliOptions): Promise<unknown> {
  const captured = Boolean(options.write);
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  if (captured) {
    const forward = (...values: unknown[]) => options.write?.(values.map((value) => String(value)).join(' '));
    console.log = forward;
    console.error = forward;
    // argparse (used internally by RushStack) writes usage text directly to
    // process streams, bypassing console.log/error.  Filter only those usage
    // blocks while an injected writer is active; normal domain output remains
    // untouched even when a caller's writer forwards to stdout.
    const filterUsage = (stream: NodeJS.WritableStream, original: (...args: any[]) => any) => (...args: unknown[]) => {
      const chunk = args[0];
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
      if (/^\s*usage:/iu.test(text)) {
        const callback = args.at(-1);
        if (typeof callback === 'function') callback();
        return true;
      }
      return Reflect.apply(original, stream, args);
    };
    process.stdout.write = filterUsage(process.stdout, originalStdoutWrite) as typeof process.stdout.write;
    process.stderr.write = filterUsage(process.stderr, originalStderrWrite) as typeof process.stderr.write;
  }
  try {
    await parser.executeWithoutErrorHandlingAsync(argumentsList);
    return parser.selectedAction instanceof CallbackAction ? parser.selectedAction.result : undefined;
  }
  catch (error) {
    if (error instanceof SealwrapperError) throw error;
    const exitCode = parserExitCode(error);
    if (exitCode !== undefined) {
      const message = stripAnsi(error instanceof Error ? error.message : String(error)).trim();
      throw new SealwrapperError(message, exitCode || 2);
    }
    throw error;
  }
  finally {
    if (captured) {
      console.log = originalLog;
      console.error = originalError;
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
  }
}

export async function runCli(argumentsList: string[], options: CliOptions) {
  if (hasOption(argumentsList, '--core')) throw new SealwrapperError('sealwrapper never uses a user-supplied core checkout; use the lock-managed core sync', 2);

  const runtimeOptions: CliOptions = {
    ...options,
    progress: options.progress ?? createProgress({ captured: Boolean(options.write) }),
  };
  const parser = createCommandLine(runtimeOptions);
  const normalized = normalizeArguments(argumentsList);
  const selectedAction = normalized.find((token) => actionNames.has(token));
  if (hasOption(normalized, '--format') && selectedAction === 'package') throw new SealwrapperError('sealwrapper is sealpack-only; package has no --format option', 2);
  if (normalized.length === 0) {
    printHelp(runtimeOptions, parser);
    return;
  }
  const helpRequested = normalized.includes('--help') || normalized.includes('-h');
  if (helpRequested) {
    const actionName = normalized.find((token) => actionNames.has(token));
    printHelp(runtimeOptions, parser, actionName);
    return;
  }
  return executeCommandLine(parser, normalized, runtimeOptions);
}

if (import.meta.main) {
  runCli(process.argv.slice(2), { cwd: process.cwd() }).catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${detail}\n`);
    process.exitCode = error instanceof SealwrapperError ? error.exitCode : 3;
  });
}
