import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SealwrapperError } from './errors.ts';
import { canonicalJson } from './capabilities.ts';

type ProcessResult = { code: number; stdout: string; stderr: string; timedOut: boolean };

function terminateProcess(child: ReturnType<typeof spawn>) {
  // Go tests can themselves start helper processes.  A detached process group
  // lets the timeout clean up the whole bridge invocation instead of leaving
  // a compiler/test descendant holding the temporary request directory open.
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch { /* process already exited */ }
  const killTimer = setTimeout(() => {
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* process already exited */ }
  }, 2_000);
  killTimer.unref();
}

function run(program: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs?: number }) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '', stderr = '', timedOut = false, settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminateProcess(child);
    }, timeoutMs);
    timer.unref();
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    child.stdout.setEncoding('utf8').on('data', (value) => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', (value) => { stderr += value; });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => finish(() => resolve({ code: code ?? 1, stdout, stderr, timedOut })));
  });
}

export function verifyBridgeResult(result: any, target: any) {
  if (!result || result.protocol !== target.testOverlay.protocol) throw new SealwrapperError('Bridge protocol mismatch', 3);
  if (result.base?.commit !== target.core.commit) throw new SealwrapperError('Bridge base commit mismatch', 3);
  if (result.base?.runtimeVersion !== target.core.runtimeVersion) throw new SealwrapperError('Bridge distribution runtime version mismatch', 3);
  if (result.base?.sourceDeclaredVersion !== target.core.sourceDeclaredVersion) throw new SealwrapperError('Bridge source declared version mismatch', 3);
  if (result.overlay?.id !== target.testOverlay.id || result.overlay?.digest !== target.testOverlay.digest) throw new SealwrapperError('Bridge overlay digest mismatch', 3);
  if (result.capabilitiesDigest !== target.testOverlay.capabilitiesSha256) throw new SealwrapperError('Bridge capabilities digest mismatch', 3);
  const observedCapabilities = { protocol: result.protocol, manifestFormatVersions: result.manifestFormatVersions, contents: result.contents, limits: result.limits };
  if (canonicalJson(observedCapabilities) !== canonicalJson(target.testOverlay.capabilities)) throw new SealwrapperError('Bridge capability contract mismatch', 3);
  if (result.nonProductionEquivalent !== false) throw new SealwrapperError('A non-production-equivalent bridge result cannot satisfy the P0 gate; nonProductionEquivalent must be false', 3);
  if (result.bridgeError) throw new SealwrapperError(`Bridge error: ${result.bridgeError}`, 3);
  return result;
}

export async function invokeBridge({ worktree, target, operation, archive = '', archives = [], scenario = {}, timeoutMs = 120_000 }: { worktree: string; target: any; operation: string; archive?: string; archives?: string[]; scenario?: any; timeoutMs?: number }): Promise<any> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new SealwrapperError('Bridge timeout must be between 1ms and 300000ms', 2);
  const directory = await mkdtemp(join(tmpdir(), 'sealwrapper-bridge-'));
  const requestPath = join(directory, 'request.json');
  const resultPath = join(directory, 'result.json');
  const request = { protocol: target.testOverlay.protocol, operation, archive, archives, runtimeVersion: target.core.runtimeVersion, baseCommit: target.core.commit, overlayDigest: target.testOverlay.digest, scenario };
  try {
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
    const processResult = await run('go', ['test', './dice', '-run', '^TestSealwrapperBridge$', '-count=1', '-timeout', '90s'], { cwd: worktree, timeoutMs, env: { SEALWRAPPER_TEST_REQUEST: requestPath, SEALWRAPPER_TEST_RESULT: resultPath } });
    if (processResult.timedOut) throw new SealwrapperError(`Bridge process timed out after ${timeoutMs}ms`, 3);
    let resultStat;
    try { resultStat = await lstat(resultPath); } catch { resultStat = undefined; }
    if (!resultStat?.isFile() || resultStat.isSymbolicLink()) throw new SealwrapperError('Bridge result must be a regular file in its private temporary directory', 3);
    let result: any;
    try { result = JSON.parse(await readFile(resultPath, 'utf8')); } catch { throw new SealwrapperError(`Bridge did not produce a result${processResult.stderr.trim() ? `:\n${processResult.stderr.trim()}` : ''}`, 3); }
    verifyBridgeResult(result, target);
    if (processResult.code !== 0) {
      const detail = `${processResult.stdout}\n${processResult.stderr}`.trim();
      throw new SealwrapperError(`Bridge go test failed${detail ? `:\n${detail}` : ''}`, 3);
    }
    return result;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
