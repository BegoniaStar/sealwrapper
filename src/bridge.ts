import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SealwrapperError } from './errors.ts';
import { canonicalJson } from './capabilities.ts';
import type { TargetDescriptor } from './pinned-target.ts';
import { runProcess } from './process.ts';

type BridgeTarget = TargetDescriptor & { testOverlay: TargetDescriptor['testOverlay'] & { digest?: string } };
type BridgeRecord = Record<string, unknown>;

export type BridgeDiagnostic = { severity: string; ruleId: string; path?: string; line?: number; column?: number; message: string };
export type BridgeMessage = BridgeRecord & { qq?: string; role?: string; scope?: string; direction?: string; timestamp?: string; text?: string; transcriptSequence?: number; inReplyToSequence?: number };
export type BridgeTranscript = BridgeRecord & { messages?: BridgeMessage[] };
export type BridgeInstall = { installed?: boolean; enabled?: boolean; reloaded?: boolean; packages?: string[] };
export type BridgeResult = BridgeRecord & {
  protocol: string;
  base: { commit: string; runtimeVersion: string; sourceDeclaredVersion: string };
  overlay: { id: string; digest: string };
  capabilitiesDigest: string;
  nonProductionEquivalent: false;
  ok?: boolean;
  diagnostics?: BridgeDiagnostic[];
  install?: BridgeInstall;
  transcript?: BridgeTranscript;
};

function record(value: unknown): BridgeRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as BridgeRecord : undefined;
}

export function verifyBridgeResult(result: unknown, target: BridgeTarget): BridgeResult {
  const bridge = record(result);
  if (!bridge || bridge.protocol !== target.testOverlay.protocol) throw new SealwrapperError('Bridge protocol mismatch', 3);
  const base = record(bridge.base);
  if (base?.commit !== target.core.commit) throw new SealwrapperError('Bridge base commit mismatch', 3);
  if (base?.runtimeVersion !== target.core.runtimeVersion) throw new SealwrapperError('Bridge distribution runtime version mismatch', 3);
  if (base?.sourceDeclaredVersion !== target.core.sourceDeclaredVersion) throw new SealwrapperError('Bridge source declared version mismatch', 3);
  const overlay = record(bridge.overlay);
  if (overlay?.id !== target.testOverlay.id || overlay?.digest !== target.testOverlay.digest) throw new SealwrapperError('Bridge overlay digest mismatch', 3);
  if (bridge.capabilitiesDigest !== target.testOverlay.capabilitiesSha256) throw new SealwrapperError('Bridge capabilities digest mismatch', 3);
  const observedCapabilities = { protocol: bridge.protocol, manifestFormatVersions: bridge.manifestFormatVersions, contents: bridge.contents, limits: bridge.limits, networkMock: bridge.networkMock };
  if (canonicalJson(observedCapabilities) !== canonicalJson(target.testOverlay.capabilities)) throw new SealwrapperError('Bridge capability contract mismatch', 3);
  if (bridge.nonProductionEquivalent !== false) throw new SealwrapperError('A non-production-equivalent bridge result cannot satisfy the P0 gate; nonProductionEquivalent must be false', 3);
  if (bridge.bridgeError) throw new SealwrapperError(`Bridge error: ${String(bridge.bridgeError)}`, 3);
  return bridge as BridgeResult;
}

export async function invokeBridge({ worktree, target, operation, archive = '', archives = [], scenario = {}, timeoutMs = 120_000 }: { worktree: string; target: BridgeTarget; operation: string; archive?: string; archives?: string[]; scenario?: unknown; timeoutMs?: number }): Promise<BridgeResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new SealwrapperError('Bridge timeout must be between 1ms and 300000ms', 2);
  const directory = await mkdtemp(join(tmpdir(), 'sealwrapper-bridge-'));
  const requestPath = join(directory, 'request.json');
  const resultPath = join(directory, 'result.json');
  const request = { protocol: target.testOverlay.protocol, operation, archive, archives, runtimeVersion: target.core.runtimeVersion, baseCommit: target.core.commit, overlayDigest: target.testOverlay.digest, scenario };
  try {
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
    const processResult = await runProcess('go', ['test', './dice', '-run', '^TestSealwrapperBridge$', '-count=1', '-timeout', `${timeoutMs}ms`], { cwd: worktree, timeoutMs, maxOutputBytes: 8 * 1024 * 1024, env: { SEALWRAPPER_TEST_REQUEST: requestPath, SEALWRAPPER_TEST_RESULT: resultPath } });
    if (processResult.timedOut) throw new SealwrapperError(`Bridge process timed out after ${timeoutMs}ms`, 3);
    if (processResult.outputExceeded) throw new SealwrapperError('Bridge process exceeded the 8 MiB output limit', 3);
    let resultStat;
    try { resultStat = await lstat(resultPath); } catch { resultStat = undefined; }
    if (!resultStat?.isFile() || resultStat.isSymbolicLink()) throw new SealwrapperError('Bridge result must be a regular file in its private temporary directory', 3);
    let result: unknown;
    try { result = JSON.parse(await readFile(resultPath, 'utf8')); } catch { throw new SealwrapperError(`Bridge did not produce a result${processResult.stderr.trim() ? `:\n${processResult.stderr.trim()}` : ''}`, 3); }
    const verified = verifyBridgeResult(result, target);
    if (processResult.code !== 0) {
      const detail = `${processResult.stdout}\n${processResult.stderr}`.trim();
      throw new SealwrapperError(`Bridge go test failed${detail ? `:\n${detail}` : ''}`, 3);
    }
    return verified;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
