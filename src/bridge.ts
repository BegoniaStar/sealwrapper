import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SealwrapperError } from './errors.ts';
import { canonicalJson } from './capabilities.ts';

function run(program: string, args: string[], options: { cwd: string; env: Record<string, string> }) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(program, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (value) => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', (value) => { stderr += value; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
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
  if (result.nonProductionEquivalent === true) throw new SealwrapperError('A non-production-equivalent bridge result cannot satisfy the P0 gate', 3);
  if (result.bridgeError) throw new SealwrapperError(`Bridge error: ${result.bridgeError}`, 3);
  return result;
}

export async function invokeBridge({ worktree, target, operation, archive = '', archives = [], scenario = {} }: { worktree: string; target: any; operation: string; archive?: string; archives?: string[]; scenario?: any }): Promise<any> {
  const directory = await mkdtemp(join(tmpdir(), 'sealwrapper-bridge-'));
  const requestPath = join(directory, 'request.json');
  const resultPath = join(directory, 'result.json');
  const request = { protocol: target.testOverlay.protocol, operation, archive, archives, runtimeVersion: target.core.runtimeVersion, baseCommit: target.core.commit, overlayDigest: target.testOverlay.digest, scenario };
  try {
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
    const processResult = await run('go', ['test', './dice', '-run', '^TestSealwrapperBridge$', '-count=1', '-timeout', '90s'], { cwd: worktree, env: { SEALWRAPPER_TEST_REQUEST: requestPath, SEALWRAPPER_TEST_RESULT: resultPath } });
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
