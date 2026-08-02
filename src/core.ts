import { spawn } from 'node:child_process';
import { access, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SealwrapperError } from './errors.ts';
import { invokeBridge } from './bridge.ts';
import { loadSealLock } from './lock.ts';

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

function corePaths(projectRoot: string) {
  const base = resolve(projectRoot, '.seal', 'core');
  return { base, mirror: join(base, 'mirror.git'), worktree: join(base, 'worktree-1.6.0'), state: join(base, 'state-1.6.0.json') };
}

async function assertExactGo(version: string) {
  const output = await checked('go', ['version']);
  if (!output.includes(`go${version} `)) throw new SealwrapperError(`Go ${version} is required by seal.lock; found ${output}`, 2);
}

async function ensureMirror(paths: ReturnType<typeof corePaths>, core: any, offline: boolean) {
  await mkdir(paths.base, { recursive: true });
  const mirrors = [...new Set(core.mirrors as string[])];
  let selected = core.source;
  if (!(await present(paths.mirror))) {
    if (offline) throw new SealwrapperError('core sync --offline cannot create a missing core mirror', 3);
    let lastFailure = '';
    for (const mirror of mirrors) {
      const cloned = await command('git', ['clone', '--mirror', mirror, paths.mirror]);
      if (cloned.code === 0) { selected = mirror; break; }
      lastFailure = cloned.stderr.trim() || cloned.stdout.trim();
      await rm(paths.mirror, { force: true, recursive: true });
    }
    if (!(await present(paths.mirror))) throw new SealwrapperError(`Unable to clone the signed core mirror set${lastFailure ? `:\n${lastFailure}` : ''}`, 3);
    // origin remains the canonical signed source even when an authenticated
    // fallback mirror supplied the initial object transfer.
    await checked('git', ['-C', paths.mirror, 'remote', 'set-url', 'origin', core.source]);
  }
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
  if (!(await present(paths.worktree))) return;
  const stat = await lstat(paths.worktree);
  if (stat.isSymbolicLink()) throw new SealwrapperError('Refusing to remove a symbolic-link core worktree', 3);
  const removed = await command('git', ['-C', paths.mirror, 'worktree', 'remove', '--force', paths.worktree]);
  if (removed.code !== 0) await rm(paths.worktree, { force: true, recursive: true });
}

async function prepareTestOnlyEmbedFixtures(worktree: string) {
  // The upstream source tree intentionally omits generated frontend embeds.
  // These inert files only satisfy go:embed during `go test`; they are never
  // committed, patched into production code, or copied into a release.
  for (const relative of ['static/frontend/sealwrapper-bridge-placeholder.txt', 'static/scripts/sealwrapper-bridge-placeholder.txt']) {
    const file = join(worktree, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'sealwrapper test-only go:embed fixture\n', { mode: 0o600 });
  }
}

export async function coreSync(projectRoot: string, { offline = false } = {}) {
  const lock = await loadSealLock(projectRoot, toolRoot);
  const target = lock.targets['1.6.0'];
  await assertExactGo(target.testOverlay.goVersion);
  const paths = corePaths(projectRoot);
  const mirror = await ensureMirror(paths, target.core, offline);
  await removeGeneratedWorktree(paths);
  await checked('git', ['-C', paths.mirror, 'worktree', 'add', '--detach', paths.worktree, target.core.commit]);
  for (const patch of target.testOverlay.patches) {
    const source = join(toolRoot, patch.path);
    await checked('git', ['-C', paths.worktree, 'apply', '--check', source]);
    await checked('git', ['-C', paths.worktree, 'apply', source]);
  }
  await prepareTestOnlyEmbedFixtures(paths.worktree);
  const bridge = await invokeBridge({ worktree: paths.worktree, target, operation: 'capabilities' });
  if (!bridge.ok) throw new SealwrapperError('Bridge capability self-check returned diagnostics', 3);
  await writeFile(paths.state, `${JSON.stringify({ target: '1.6.0', mirror, baseCommit: target.core.commit, runtimeVersion: target.core.runtimeVersion, sourceDeclaredVersion: target.core.sourceDeclaredVersion, overlayDigest: target.testOverlay.digest, protocol: target.testOverlay.protocol, capabilitiesSha256: target.testOverlay.capabilitiesSha256 }, null, 2)}\n`, 'utf8');
  return coreVerify(projectRoot);
}

export async function coreVerify(projectRoot: string) {
  const lock = await loadSealLock(projectRoot, toolRoot);
  const target = lock.targets['1.6.0'];
  const paths = corePaths(projectRoot);
  if (!(await present(paths.mirror)) || !(await present(paths.worktree)) || !(await present(paths.state))) throw new SealwrapperError('Managed core worktree is missing; run sealwrapper core sync', 3);
  const remote = await checked('git', ['-C', paths.mirror, 'remote', 'get-url', 'origin']);
  if (remote !== target.core.source) throw new SealwrapperError(`Managed core mirror remote mismatch: expected ${target.core.source}, found ${remote}`, 3);
  const head = await checked('git', ['-C', paths.worktree, 'rev-parse', 'HEAD']);
  if (head !== target.core.commit) throw new SealwrapperError(`Managed core worktree is at ${head}, expected ${target.core.commit}`, 3);
  for (const patch of target.testOverlay.patches) await checked('git', ['-C', paths.worktree, 'apply', '--reverse', '--check', join(toolRoot, patch.path)]);
  const status = (await checked('git', ['-C', paths.worktree, 'status', '--porcelain'])).split('\n').filter(Boolean).sort();
  // static/frontend is ignored by upstream because release builds generate it;
  // its inert fixture is checked by the explicit file read below instead.
  const expectedStatus = ['?? dice/zz_sealwrapper_bridge_test.go', '?? static/scripts/sealwrapper-bridge-placeholder.txt'];
  if (JSON.stringify(status) !== JSON.stringify(expectedStatus)) throw new SealwrapperError('Managed core worktree has changes outside the locked test-only overlay', 3);
  for (const relative of ['static/frontend/sealwrapper-bridge-placeholder.txt', 'static/scripts/sealwrapper-bridge-placeholder.txt']) {
    const fixture = await readFile(join(paths.worktree, relative), 'utf8').catch(() => '');
    if (fixture !== 'sealwrapper test-only go:embed fixture\n') throw new SealwrapperError(`Managed core fixture is missing or modified: ${relative}`, 3);
  }
  const state = JSON.parse(await readFile(paths.state, 'utf8'));
  if (state.baseCommit !== target.core.commit || state.runtimeVersion !== target.core.runtimeVersion || state.overlayDigest !== target.testOverlay.digest || state.capabilitiesSha256 !== target.testOverlay.capabilitiesSha256 || !target.core.mirrors.includes(state.mirror)) throw new SealwrapperError('Managed core state does not match seal.lock', 3);
  return { target: '1.6.0', worktree: paths.worktree, remote, mirror: state.mirror, baseCommit: target.core.commit, runtimeVersion: target.core.runtimeVersion, sourceDeclaredVersion: target.core.sourceDeclaredVersion, overlay: { id: target.testOverlay.id, digest: target.testOverlay.digest, protocol: target.testOverlay.protocol, patches: target.testOverlay.patches, capabilitiesSha256: target.testOverlay.capabilitiesSha256 } };
}
