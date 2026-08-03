import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, lstat, mkdir, readFile, readlink, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SealwrapperError } from './errors.ts';
import { invokeBridge } from './bridge.ts';
import { loadSealLock, lockedTarget, lockDefaultTarget, type LockedTarget } from './lock.ts';

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type CommandResult = { code: number; stdout: string; stderr: string };

async function command(program: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

async function checked(program: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = await command(program, args, options);
  if (result.code !== 0) throw new SealwrapperError(`${program} ${args.join(' ')} failed${result.stderr.trim() ? `:\n${result.stderr.trim()}` : ''}`, 3);
  return result.stdout.trim();
}

async function present(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function corePaths(projectRoot: string, targetId: string) {
  const root = resolve(projectRoot);
  const seal = join(root, '.seal');
  const base = join(seal, 'core', targetId);
  return { projectRoot: root, seal, base, mirror: join(base, 'mirror.git'), worktree: join(base, 'worktree'), state: join(base, 'state.json'), targetId };
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

/**
 * Validate every existing component of a managed path before handing it to
 * Git or the filesystem.  A symlink in .seal/core is never part of the
 * managed layout: following one would let a clone, worktree, or state write
 * escape the project root.  Missing final components are allowed during sync,
 * but their nearest existing parent must still resolve beneath the project.
 */
async function assertManagedPath(path: string, projectRoot: string): Promise<void> {
  const root = resolve(projectRoot);
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch (error: any) {
    throw new SealwrapperError(`Project root cannot be resolved: ${root}${error?.message ? ` (${error.message})` : ''}`, 3);
  }
  const absolute = resolve(path);
  if (!isWithin(root, absolute)) throw new SealwrapperError(`Managed core path escapes the project root: ${path}`, 3);
  const parts = relative(root, absolute).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); } catch (error: any) {
      if (error?.code === 'ENOENT') break;
      throw new SealwrapperError(`Unable to inspect managed core path ${current}: ${error?.message ?? error}`, 3);
    }
    if (stat.isSymbolicLink()) throw new SealwrapperError(`Refusing symbolic-link managed core path: ${current}`, 3);
    let resolvedPath: string;
    try { resolvedPath = await realpath(current); } catch (error: any) {
      throw new SealwrapperError(`Unable to resolve managed core path ${current}: ${error?.message ?? error}`, 3);
    }
    if (!isWithin(rootReal, resolvedPath)) throw new SealwrapperError(`Managed core path resolves outside the project root: ${current}`, 3);
  }
}

async function assertDirectory(path: string, label: string): Promise<void> {
  let stat;
  try { stat = await lstat(path); } catch (error: any) {
    if (error?.code === 'ENOENT') throw new SealwrapperError(`${label} is missing; run sealwrapper core sync`, 3);
    throw new SealwrapperError(`Unable to inspect ${label}: ${error?.message ?? error}`, 3);
  }
  if (stat.isSymbolicLink()) throw new SealwrapperError(`Refusing symbolic-link ${label}`, 3);
  if (!stat.isDirectory()) throw new SealwrapperError(`${label} is not a directory`, 3);
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  let stat;
  try { stat = await lstat(path); } catch (error: any) {
    if (error?.code === 'ENOENT') throw new SealwrapperError(`${label} is missing; run sealwrapper core sync`, 3);
    throw new SealwrapperError(`Unable to inspect ${label}: ${error?.message ?? error}`, 3);
  }
  if (stat.isSymbolicLink()) throw new SealwrapperError(`Refusing symbolic-link ${label}`, 3);
  if (!stat.isFile()) throw new SealwrapperError(`${label} is not a regular file`, 3);
}

export type ToolchainDiagnostic = { tool: 'node' | 'git' | 'go'; ok: boolean; required?: string; found: string; message: string };

/** Probe every prerequisite before any mirror, worktree, or generated state is touched. */
export async function diagnoseToolchain(goVersions: readonly string[] = []): Promise<{ ok: boolean; diagnostics: ToolchainDiagnostic[]; node: string; git: string; go: string }> {
  const probe = async (program: string, args: string[]): Promise<CommandResult> => {
    try { return await command(program, args); }
    catch (error) { return { code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) }; }
  };
  const node = process.versions.node;
  const nodeParts = node.split('.').map((part) => Number(part));
  const nodeOk = nodeParts[0] === 26 && nodeParts[1] >= 5;
  const diagnostics: ToolchainDiagnostic[] = [{ tool: 'node', ok: nodeOk, required: '>=26.5.0 <27', found: node, message: nodeOk ? `Node ${node}` : `Node >=26.5.0 <27 is required; found ${node}` }];
  const gitResult = await probe('git', ['--version']);
  const git = (gitResult.stdout || gitResult.stderr).trim();
  diagnostics.push({ tool: 'git', ok: gitResult.code === 0, found: git || 'unavailable', message: gitResult.code === 0 ? git : 'Git is required by seal.lock; unavailable' });
  const goResult = await probe('go', ['version']);
  const go = (goResult.stdout || goResult.stderr).trim();
  const expected = [...new Set(goVersions)];
  const goOk = goResult.code === 0 && expected.every((version) => go.includes(`go${version} `));
  const required = expected.length ? expected.join(', ') : undefined;
  diagnostics.push({ tool: 'go', ok: goOk, required, found: go || 'unavailable', message: goResult.code !== 0 ? `Go ${required ?? 'toolchain'} required by seal.lock; unavailable` : goOk ? go : `Go ${required} required by seal.lock; found ${go}` });
  return { ok: diagnostics.every((item) => item.ok), diagnostics, node, git, go };
}

export function toolchainError(diagnostics: readonly ToolchainDiagnostic[]): SealwrapperError {
  return new SealwrapperError(`Toolchain preflight failed:\n${diagnostics.filter((item) => !item.ok).map((item) => `- ${item.message}`).join('\n')}`, 2);
}

async function ensureMirror(paths: ReturnType<typeof corePaths>, core: any, offline: boolean) {
  await assertManagedPath(paths.base, paths.projectRoot);
  if (await present(paths.seal)) await assertDirectory(paths.seal, 'Managed .seal directory');
  else await mkdir(paths.seal, { recursive: false });
  const coreRoot = dirname(paths.base);
  await assertManagedPath(coreRoot, paths.projectRoot);
  if (await present(coreRoot)) await assertDirectory(coreRoot, 'Managed core root directory');
  else await mkdir(coreRoot, { recursive: false });
  if (await present(paths.base)) await assertDirectory(paths.base, 'Managed core directory');
  else await mkdir(paths.base, { recursive: false });
  await assertManagedPath(paths.base, paths.projectRoot);
  await assertDirectory(paths.base, 'Managed core directory');
  const mirrors = [...new Set(core.mirrors as string[])];
  let selected = core.source;
  await assertManagedPath(paths.mirror, paths.projectRoot);
  if (!(await present(paths.mirror))) {
    if (offline) throw new SealwrapperError('core sync --offline cannot create a missing core mirror', 3);
    let lastFailure = '';
    for (const mirror of mirrors) {
      const cloned = await command('git', ['clone', '--mirror', mirror, paths.mirror]);
      if (cloned.code === 0) { selected = mirror; break; }
      lastFailure = cloned.stderr.trim() || cloned.stdout.trim();
      await assertManagedPath(paths.mirror, paths.projectRoot);
      await rm(paths.mirror, { force: true, recursive: true });
    }
    if (!(await present(paths.mirror))) throw new SealwrapperError(`Unable to clone the signed core mirror set${lastFailure ? `:\n${lastFailure}` : ''}`, 3);
    // origin remains the canonical signed source even when an authenticated
    // fallback mirror supplied the initial object transfer.
    await assertDirectory(paths.mirror, 'Managed core mirror');
    await checked('git', ['-C', paths.mirror, 'remote', 'set-url', 'origin', core.source]);
  }
  await assertDirectory(paths.mirror, 'Managed core mirror');
  const remote = await checked('git', ['-C', paths.mirror, 'remote', 'get-url', 'origin']);
  if (remote !== core.source) throw new SealwrapperError(`Managed core mirror remote mismatch: expected ${core.source}, found ${remote}`, 3);
  if (!offline) {
    let fetched = false;
    let lastFailure = '';
    for (const mirror of mirrors) {
      const source = mirror === core.source ? 'origin' : mirror;
      const result = await command('git', ['-C', paths.mirror, 'fetch', '--prune', source]);
      if (result.code === 0) { selected = mirror; fetched = true; break; }
      lastFailure = result.stderr.trim() || result.stdout.trim();
    }
    if (!fetched) throw new SealwrapperError(`Unable to fetch the signed core mirror set${lastFailure ? `:\n${lastFailure}` : ''}`, 3);
  }
  await checked('git', ['-C', paths.mirror, 'cat-file', '-e', `${core.commit}^{commit}`]);
  return selected;
}

async function removeGeneratedWorktree(paths: ReturnType<typeof corePaths>) {
  await assertManagedPath(paths.worktree, paths.projectRoot);
  if (!(await present(paths.worktree))) return;
  const stat = await lstat(paths.worktree);
  if (stat.isSymbolicLink()) throw new SealwrapperError('Refusing to remove a symbolic-link core worktree', 3);
  if (!stat.isDirectory()) throw new SealwrapperError('Managed core worktree is not a directory', 3);
  const removed = await command('git', ['-C', paths.mirror, 'worktree', 'remove', '--force', paths.worktree]);
  if (removed.code !== 0) {
    await assertManagedPath(paths.worktree, paths.projectRoot);
    await rm(paths.worktree, { force: true, recursive: true });
  }
}

async function prepareTestOnlyEmbedFixtures(worktree: string) {
  // The upstream source tree intentionally omits generated frontend embeds.
  // These inert files only satisfy go:embed during `go test`; they are never
  // committed, patched into production code, or copied into a release.
  for (const relative of ['static/frontend/sealwrapper-bridge-placeholder.txt', 'static/scripts/sealwrapper-bridge-placeholder.txt']) {
    const file = join(worktree, relative);
    await assertManagedPath(dirname(file), worktree);
    await assertManagedPath(file, worktree);
    await mkdir(dirname(file), { recursive: true });
    await assertManagedPath(dirname(file), worktree);
    await assertManagedPath(file, worktree);
    await writeFile(file, 'sealwrapper test-only go:embed fixture\n', { mode: 0o600 });
    await assertManagedPath(file, worktree);
  }
}

async function overlayTestFiles(target: LockedTarget): Promise<string[]> {
  const files = new Set<string>();
  for (const patch of target.testOverlay.patches) {
    const data = await readFile(join(toolRoot, patch.path), 'utf8');
    for (const match of data.matchAll(/^diff --git a\/(dice\/[^\n]+_test\.go) b\/dice\/[^\n]+_test\.go$/gmu)) files.add(match[1]);
  }
  if (files.size === 0) throw new SealwrapperError(`Target ${target.id} overlay does not add a test-only bridge source`, 3);
  return [...files].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
}

export async function coreSync(projectRoot: string, { targetId, offline = false }: { targetId?: string; offline?: boolean } = {}) {
  const lock = await loadSealLock(projectRoot, toolRoot);
  const selectedTargetId = targetId ?? lockDefaultTarget(lock);
  const target = lockedTarget(lock, selectedTargetId);
  const toolchain = await diagnoseToolchain([target.testOverlay.goVersion]);
  if (!toolchain.ok) throw toolchainError(toolchain.diagnostics);
  const paths = corePaths(projectRoot, selectedTargetId);
  await assertManagedPath(paths.seal, paths.projectRoot);
  await assertManagedPath(paths.base, paths.projectRoot);
  const mirror = await ensureMirror(paths, target.core, offline);
  await removeGeneratedWorktree(paths);
  await assertManagedPath(paths.worktree, paths.projectRoot);
  await checked('git', ['-C', paths.mirror, 'worktree', 'add', '--detach', paths.worktree, target.core.commit]);
  await assertDirectory(paths.worktree, 'Managed core worktree');
  for (const patch of target.testOverlay.patches) {
    const source = join(toolRoot, patch.path);
    await checked('git', ['-C', paths.worktree, 'apply', '--check', source]);
    await checked('git', ['-C', paths.worktree, 'apply', source]);
  }
  await prepareTestOnlyEmbedFixtures(paths.worktree);
  const bridge = await invokeBridge({ worktree: paths.worktree, target, operation: 'capabilities' });
  if (!bridge.ok) throw new SealwrapperError('Bridge capability self-check returned diagnostics', 3);
  await assertManagedPath(paths.state, paths.projectRoot);
  await writeFile(paths.state, `${JSON.stringify({ target: selectedTargetId, mirror, baseCommit: target.core.commit, runtimeVersion: target.core.runtimeVersion, sourceDeclaredVersion: target.core.sourceDeclaredVersion, overlayDigest: target.testOverlay.digest, protocol: target.testOverlay.protocol, capabilitiesSha256: target.testOverlay.capabilitiesSha256 }, null, 2)}\n`, 'utf8');
  return coreVerify(projectRoot, { targetId: selectedTargetId });
}

type TrackedTreeEntry = { mode: string; type: string; object: string; path: string };

function parseTrackedTree(output: string): TrackedTreeEntry[] {
  const entries: TrackedTreeEntry[] = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    const separator = record.indexOf('\t');
    if (separator < 0) throw new SealwrapperError('Managed core tree listing is malformed', 3);
    const [mode, type, object] = record.slice(0, separator).split(' ');
    const path = record.slice(separator + 1);
    if (!mode || !type || !object || !path || isAbsolute(path) || path.split('/').some((part) => part === '..' || part === '')) {
      throw new SealwrapperError(`Managed core tree contains an unsafe path: ${path || '<empty>'}`, 3);
    }
    entries.push({ mode, type, object, path });
  }
  return entries;
}

function parseIndexFlags(output: string): Array<{ flag: string; path: string }> {
  const flags: Array<{ flag: string; path: string }> = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    if (record.length < 3 || record[1] !== ' ') throw new SealwrapperError('Managed core index listing is malformed', 3);
    flags.push({ flag: record[0], path: record.slice(2) });
  }
  return flags;
}

async function hashTrackedData(worktree: string, entry: TrackedTreeEntry, hashAlgorithm: 'sha1' | 'sha256'): Promise<string> {
  const file = join(worktree, entry.path);
  const stat = await lstat(file).catch((error: any) => {
    if (error?.code === 'ENOENT') return undefined;
    throw new SealwrapperError(`Unable to inspect managed core tracked file ${entry.path}: ${error?.message ?? error}`, 3);
  });
  if (entry.type === 'commit' && entry.mode === '160000') {
    // The pinned source contains gitlinks whose submodules are deliberately
    // not initialized by the managed checkout.  Keep the directory itself
    // in-tree and empty; otherwise ignored submodule content could influence
    // a build without appearing in the superproject's status output.
    // Git leaves an uninitialized submodule absent; that is equivalent to an
    // empty gitlink for this source-only verification.
    if (!stat) return entry.object;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SealwrapperError(`Managed core gitlink is not an empty directory: ${entry.path}`, 3);
    const children = await readdir(file);
    if (children.length) throw new SealwrapperError(`Managed core gitlink contains untracked content: ${entry.path}`, 3);
    return entry.object;
  }
  if (entry.type !== 'blob') throw new SealwrapperError(`Managed core tracked entry is not a blob or gitlink: ${entry.path}`, 3);
  if (!stat) throw new SealwrapperError(`Managed core tracked file is missing: ${entry.path}`, 3);
  let data: Buffer;
  if (stat.isSymbolicLink()) {
    const link = await readlink(file, 'utf8');
    const target = await realpath(file).catch(() => '');
    if (!target || !isWithin(await realpath(worktree), target)) throw new SealwrapperError(`Managed core tracked symlink escapes worktree: ${entry.path}`, 3);
    data = Buffer.from(link, 'utf8');
  } else {
    if (!stat.isFile()) throw new SealwrapperError(`Managed core tracked path is not a regular file: ${entry.path}`, 3);
    data = await readFile(file);
  }
  const hash = createHash(hashAlgorithm);
  hash.update(`blob ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/**
 * Hash every blob in HEAD directly from the checkout.  Git's status/diff
 * commands intentionally honour assume-unchanged and skip-worktree flags;
 * this independent tree walk makes those flags unable to hide a production
 * file modification.
 */
async function verifyTrackedTree(worktree: string): Promise<void> {
  const format = await checked('git', ['-C', worktree, 'rev-parse', '--show-object-format']);
  if (format !== 'sha1' && format !== 'sha256') throw new SealwrapperError(`Unsupported managed core Git object format: ${format}`, 3);
  const treeResult = await command('git', ['-C', worktree, 'ls-tree', '-r', '-z', '--full-tree', 'HEAD']);
  if (treeResult.code !== 0) throw new SealwrapperError(`Unable to enumerate managed core tree${treeResult.stderr.trim() ? `:\n${treeResult.stderr.trim()}` : ''}`, 3);
  const entries = parseTrackedTree(treeResult.stdout);
  const indexResult = await command('git', ['-C', worktree, 'ls-files', '-v', '-z']);
  if (indexResult.code !== 0) throw new SealwrapperError(`Unable to inspect managed core index${indexResult.stderr.trim() ? `:\n${indexResult.stderr.trim()}` : ''}`, 3);
  const indexFlags = parseIndexFlags(indexResult.stdout);
  const treePaths = new Set(entries.map((entry) => entry.path));
  const indexPaths = new Set(indexFlags.map((entry) => entry.path));
  if (treePaths.size !== indexPaths.size || [...treePaths].some((path) => !indexPaths.has(path))) throw new SealwrapperError('Managed core index does not exactly match its locked HEAD tree', 3);
  for (const { flag, path } of indexFlags) {
    if (flag === 'S' || flag === 's' || flag === 'h') throw new SealwrapperError(`Managed core index uses ${flag === 'h' ? 'assume-unchanged' : 'skip-worktree'} for ${path}`, 3);
  }
  const root = await realpath(worktree);
  for (const entry of entries) {
    const file = join(worktree, entry.path);
    if (!isWithin(root, resolve(file))) throw new SealwrapperError(`Managed core tracked path escapes worktree: ${entry.path}`, 3);
    const actual = await hashTrackedData(worktree, entry, format);
    if (actual !== entry.object) throw new SealwrapperError(`Managed core tracked file differs from locked tree: ${entry.path}`, 3);
  }
}

async function verifyWorktreeGitLayout(paths: ReturnType<typeof corePaths>): Promise<void> {
  const gitFile = join(paths.worktree, '.git');
  await assertRegularFile(gitFile, 'Managed core worktree .git file');
  const bare = await checked('git', ['-C', paths.mirror, 'rev-parse', '--is-bare-repository']);
  if (bare !== 'true') throw new SealwrapperError('Managed core mirror is not a bare Git repository', 3);
  const gitDir = resolve(paths.worktree, await checked('git', ['-C', paths.worktree, 'rev-parse', '--git-dir']));
  const commonDir = resolve(paths.worktree, await checked('git', ['-C', paths.worktree, 'rev-parse', '--git-common-dir']));
  const mirrorReal = await realpath(paths.mirror);
  const gitDirReal = await realpath(gitDir).catch(() => '');
  const commonReal = await realpath(commonDir).catch(() => '');
  if (!gitDirReal || !isWithin(mirrorReal, gitDirReal) || !commonReal || !isWithin(mirrorReal, commonReal)) {
    throw new SealwrapperError('Managed core worktree Git metadata resolves outside its locked mirror', 3);
  }
}

async function verifyMirrorLayout(paths: ReturnType<typeof corePaths>): Promise<void> {
  // A bare mirror is itself managed state.  Check the directories Git will
  // traverse so an objects/refs/worktrees symlink cannot redirect Git reads or
  // writes outside .seal/core.
  for (const relativePath of ['HEAD', 'config', 'objects', 'refs', 'worktrees']) {
    const path = join(paths.mirror, relativePath);
    await assertManagedPath(path, paths.projectRoot);
    if (await present(path)) {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new SealwrapperError(`Refusing symbolic-link managed core mirror entry: ${relativePath}`, 3);
    }
  }
  for (const relativePath of ['objects/info/alternates', 'objects/info/http-alternates']) {
    const path = join(paths.mirror, relativePath);
    await assertManagedPath(path, paths.projectRoot);
    if (await present(path)) {
      await assertRegularFile(path, `Managed core mirror ${relativePath}`);
      const data = (await readFile(path, 'utf8')).trim();
      if (data) throw new SealwrapperError(`Managed core mirror uses an external object alternate: ${relativePath}`, 3);
    }
  }
  const pending = [paths.mirror];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error: any) {
      throw new SealwrapperError(`Unable to inspect managed core mirror entry ${directory}: ${error?.message ?? error}`, 3);
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new SealwrapperError(`Refusing symbolic-link managed core mirror entry: ${relative(paths.mirror, path)}`, 3);
      if (entry.isDirectory()) pending.push(path);
    }
  }
}

async function verifyWorktreeSymlinks(worktree: string): Promise<void> {
  const root = await realpath(worktree);
  const pending = [worktree];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error: any) {
      throw new SealwrapperError(`Unable to inspect managed core worktree entry ${directory}: ${error?.message ?? error}`, 3);
    }
    for (const entry of entries) {
      // .git is a regular administrative file in a linked worktree.  If a
      // future Git layout uses a directory there, it is checked as ordinary
      // managed content rather than traversed into the mirror metadata.
      if (entry.name === '.git') continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const resolvedPath = await realpath(path).catch(() => '');
        if (!resolvedPath || !isWithin(root, resolvedPath)) throw new SealwrapperError(`Managed core worktree symlink escapes its root: ${relative(worktree, path)}`, 3);
      } else if (entry.isDirectory()) pending.push(path);
    }
  }
}

export async function coreVerify(projectRoot: string, { targetId }: { targetId?: string } = {}) {
  const lock = await loadSealLock(projectRoot, toolRoot);
  const selectedTargetId = targetId ?? lockDefaultTarget(lock);
  const target = lockedTarget(lock, selectedTargetId);
  const paths = corePaths(projectRoot, selectedTargetId);
  await assertManagedPath(paths.seal, paths.projectRoot);
  await assertManagedPath(paths.base, paths.projectRoot);
  await assertManagedPath(paths.mirror, paths.projectRoot);
  await assertManagedPath(paths.worktree, paths.projectRoot);
  await assertManagedPath(paths.state, paths.projectRoot);
  if (!(await present(paths.mirror)) || !(await present(paths.worktree)) || !(await present(paths.state))) throw new SealwrapperError('Managed core worktree is missing; run sealwrapper core sync', 3);
  await assertDirectory(paths.base, 'Managed core directory');
  await assertDirectory(paths.mirror, 'Managed core mirror');
  await assertDirectory(paths.worktree, 'Managed core worktree');
  await assertRegularFile(paths.state, 'Managed core state');
  await verifyMirrorLayout(paths);
  await verifyWorktreeGitLayout(paths);
  await verifyWorktreeSymlinks(paths.worktree);
  const remote = await checked('git', ['-C', paths.mirror, 'remote', 'get-url', 'origin']);
  if (remote !== target.core.source) throw new SealwrapperError(`Managed core mirror remote mismatch: expected ${target.core.source}, found ${remote}`, 3);
  const head = await checked('git', ['-C', paths.worktree, 'rev-parse', 'HEAD']);
  if (head !== target.core.commit) throw new SealwrapperError(`Managed core worktree is at ${head}, expected ${target.core.commit}`, 3);
  await checked('git', ['-C', paths.mirror, 'cat-file', '-e', `${target.core.commit}^{commit}`]);
  await verifyTrackedTree(paths.worktree);
  for (const patch of target.testOverlay.patches) await checked('git', ['-C', paths.worktree, 'apply', '--reverse', '--check', join(toolRoot, patch.path)]);
  const bridgeFiles = await overlayTestFiles(target);
  const status = (await checked('git', ['-C', paths.worktree, 'status', '--porcelain'])).split('\n').filter(Boolean).sort();
  // static/frontend is ignored by upstream because release builds generate it;
  // its inert fixture is checked by the explicit file read below instead.
  const expectedStatus = [...bridgeFiles.map((path) => `?? ${path}`), '?? static/scripts/sealwrapper-bridge-placeholder.txt'].sort();
  if (JSON.stringify(status) !== JSON.stringify(expectedStatus)) throw new SealwrapperError('Managed core worktree has changes outside the locked test-only overlay', 3);
  const ignoredResult = await command('git', ['-C', paths.worktree, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
  if (ignoredResult.code !== 0) throw new SealwrapperError(`Unable to inspect ignored managed core files${ignoredResult.stderr.trim() ? `:\n${ignoredResult.stderr.trim()}` : ''}`, 3);
  const ignored = ignoredResult.stdout.split('\0').filter(Boolean).sort();
  // Git versions/configurations differ on whether the generated test-only
  // files are reported as ignored or ordinary untracked paths.  Accept only
  // this exact allowlist in either category; every other ignored file could
  // affect the Go build despite being hidden from `git status`.
  const allowedIgnored = new Set([...bridgeFiles, 'static/frontend/sealwrapper-bridge-placeholder.txt', 'static/scripts/sealwrapper-bridge-placeholder.txt']);
  if (ignored.some((path) => !allowedIgnored.has(path))) throw new SealwrapperError('Managed core worktree contains unexpected ignored files', 3);
  for (const bridgeFile of bridgeFiles) {
    const bridgeOverlay = join(paths.worktree, bridgeFile);
    await assertManagedPath(dirname(bridgeOverlay), paths.worktree);
    await assertRegularFile(bridgeOverlay, 'Managed core test-only bridge overlay');
  }
  for (const relative of ['static/frontend/sealwrapper-bridge-placeholder.txt', 'static/scripts/sealwrapper-bridge-placeholder.txt']) {
    const fixturePath = join(paths.worktree, relative);
    await assertManagedPath(fixturePath, paths.worktree);
    await assertRegularFile(fixturePath, `Managed core fixture ${relative}`);
    const fixture = await readFile(fixturePath, 'utf8').catch(() => '');
    if (fixture !== 'sealwrapper test-only go:embed fixture\n') throw new SealwrapperError(`Managed core fixture is missing or modified: ${relative}`, 3);
  }
  let state: any;
  try { state = JSON.parse(await readFile(paths.state, 'utf8')); } catch (error: any) {
    throw new SealwrapperError(`Managed core state is not valid JSON: ${error?.message ?? error}`, 3);
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new SealwrapperError('Managed core state must be a JSON object', 3);
  if (state.target !== selectedTargetId || state.baseCommit !== target.core.commit || state.runtimeVersion !== target.core.runtimeVersion || state.overlayDigest !== target.testOverlay.digest || state.capabilitiesSha256 !== target.testOverlay.capabilitiesSha256 || !target.core.mirrors.includes(state.mirror)) throw new SealwrapperError('Managed core state does not match seal.lock', 3);
  return { target: selectedTargetId, worktree: paths.worktree, remote, mirror: state.mirror, baseCommit: target.core.commit, runtimeVersion: target.core.runtimeVersion, sourceDeclaredVersion: target.core.sourceDeclaredVersion, overlay: { id: target.testOverlay.id, digest: target.testOverlay.digest, protocol: target.testOverlay.protocol, patches: target.testOverlay.patches, capabilitiesSha256: target.testOverlay.capabilitiesSha256 } };
}
