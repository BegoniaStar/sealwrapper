import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { invariant, SealwrapperError } from './errors.ts';
import { capabilitiesDigest, type BridgeCapabilities, diffCapabilities } from './capabilities.ts';
import { verifyTargetTrust } from './trust.ts';

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function overlayDigest(patches: any[]): string {
  return `sha256:${createHash('sha256').update(canonicalJson(patches.map((patch) => ({ path: patch.path, sha256: patch.sha256 })))).digest('hex')}`;
}

function patchPath(root: string, patch: any): string {
  invariant(typeof patch.path === 'string' && patch.path.startsWith('patches/sealdice-core/1.6.0/') && patch.path.endsWith('.patch') && !patch.path.includes('..') && !isAbsolute(patch.path), 'test-only overlay patch path is invalid');
  invariant(/test-only/.test(patch.path), 'test-only overlay patch filename must state test-only intent');
  return join(root, patch.path);
}

function validateTarget(target: any, root: string): any {
  invariant(isRecord(target), 'seal.lock target must be an object');
  const core = target.core;
  invariant(isRecord(core), 'seal.lock target.core must be an object');
  invariant(core.version === '1.6.0' && core.runtimeVersion === '1.6.0+20260726', 'seal.lock only supports target 1.6.0 with its locked runtime version');
  invariant(core.source === 'https://github.com/sealdice/sealdice-core' && /^[0-9a-f]{40}$/.test(core.commit), 'seal.lock core source and commit must be locked');
  invariant(Array.isArray(core.mirrors) && core.mirrors.every((mirror) => typeof mirror === 'string' && /^https:\/\//.test(mirror)), 'seal.lock core mirrors must be HTTPS URLs');
  invariant(core.sourceDeclaredVersion === '1.5.1-dev', 'seal.lock must acknowledge the locked source declaration');
  invariant(/^sha256:[0-9a-f]{64}$/.test(core.releaseArtifactSha256), 'seal.lock core releaseArtifactSha256 must be sha256');
  const overlay = target.testOverlay;
  invariant(isRecord(overlay), 'seal.lock target.testOverlay must be an object');
  invariant(overlay.id === 'sealwrapper-core-overlay/2' && overlay.protocol === 'sealwrapper.core-bridge/v2' && overlay.goVersion === '1.25.0', 'seal.lock bridge identity, protocol, and Go version must be locked');
  invariant(/^sha256:[0-9a-f]{64}$/.test(overlay.capabilitiesSha256), 'seal.lock capabilitiesSha256 must be sha256');
  invariant(isRecord(overlay.capabilities), 'seal.lock must record the bridge capabilities used for capability diffs');
  invariant(capabilitiesDigest(overlay.capabilities as BridgeCapabilities) === overlay.capabilitiesSha256, 'seal.lock capabilitiesSha256 does not match its canonical capability contract');
  invariant(Array.isArray(overlay.patches) && overlay.patches.length > 0, 'seal.lock requires an ordered test-only overlay patch series');
  for (const patch of overlay.patches) {
    const source = patchPath(root, patch);
    invariant(/^[0-9a-f]{64}$/.test(patch.sha256), 'seal.lock test overlay patch sha256 must be hexadecimal');
    let data: Buffer;
    try {
      data = requirePatch(source);
    } catch (error) {
      throw new SealwrapperError(`Unable to read locked overlay patch ${patch.path}: ${(error as Error).message}`, 3);
    }
    const actual = createHash('sha256').update(data).digest('hex');
    invariant(actual === patch.sha256, `Locked overlay patch sha256 mismatch for ${patch.path}`, 3);
    const diff = data.toString('utf8');
    invariant(/^diff --git a\/dice\/[^\n]+_test\.go b\/dice\/[^\n]+_test\.go/m.test(diff), `Overlay patch is not test-only: ${patch.path}`, 3);
    invariant(!/^--- a\/(?!dice\/[^\n]+_test\.go$)/m.test(diff) && !/^\+\+\+ b\/(?!dice\/[^\n]+_test\.go$)/m.test(diff), `Overlay patch changes production files: ${patch.path}`, 3);
  }
  const resolved = { ...target, testOverlay: { ...overlay, digest: overlayDigest(overlay.patches) } };
  verifyTargetTrust(resolved);
  return resolved;
}

/** Render a reviewable old/new lock change summary without mutating either. */
export function describeLockDiff(previous: unknown, next: any): string[] {
  const oldTarget = isRecord(previous) && isRecord(previous.targets) ? previous.targets['1.6.0'] : undefined;
  const oldCore = isRecord(oldTarget) && isRecord(oldTarget.core) ? oldTarget.core : {};
  const oldOverlay = isRecord(oldTarget) && isRecord(oldTarget.testOverlay) ? oldTarget.testOverlay : {};
  const target = next.targets['1.6.0'];
  const lines: string[] = [];
  const compare = (label: string, left: unknown, right: unknown) => { if (left !== right) lines.push(`${label}: ${typeof left === 'string' ? left : '<none>'} -> ${typeof right === 'string' ? right : '<none>'}`); };
  compare('core.version', oldCore.version, target.core.version);
  compare('core.commit', oldCore.commit, target.core.commit);
  compare('core.runtimeVersion', oldCore.runtimeVersion, target.core.runtimeVersion);
  compare('core.releaseArtifactSha256', oldCore.releaseArtifactSha256, target.core.releaseArtifactSha256);
  compare('overlay.protocol', oldOverlay.protocol, target.testOverlay.protocol);
  compare('overlay.capabilitiesSha256', oldOverlay.capabilitiesSha256, target.testOverlay.capabilitiesSha256);
  const oldPatches = Array.isArray(oldOverlay.patches) ? oldOverlay.patches : [];
  const newPatches = Array.isArray(target.testOverlay.patches) ? target.testOverlay.patches : [];
  const count = Math.max(oldPatches.length, newPatches.length);
  for (let index = 0; index < count; index += 1) {
    const left = oldPatches[index], right = newPatches[index];
    if (canonicalJson(left) !== canonicalJson(right)) lines.push(`overlay.patch[${index + 1}]: ${left ? `${left.path}@${left.sha256}` : '<none>'} -> ${right ? `${right.path}@${right.sha256}` : '<none>'}`);
  }
  lines.push(...diffCapabilities(oldOverlay.capabilities ?? {}, target.testOverlay.capabilities));
  return lines.length ? lines : ['No lock contract changes.'];
}

function requirePatch(path: string): Buffer {
  // Node's synchronous filesystem access makes validation deterministic before
  // any clone or worktree mutation. It is isolated to immutable tool assets.
  return readFileSync(path);
}

export function validateSealLock(raw: unknown, overlayRoot: string): any {
  invariant(isRecord(raw) && raw.lockVersion === 1 && isRecord(raw.targets), 'seal.lock must use lockVersion: 1');
  const keys = Object.keys(raw.targets);
  invariant(keys.length === 1 && keys[0] === '1.6.0', 'seal.lock only supports exact target 1.6.0');
  return { lockVersion: 1, targets: { '1.6.0': validateTarget(raw.targets['1.6.0'], overlayRoot) } };
}

export async function loadSealLock(projectRoot: string, overlayRoot: string): Promise<any> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolve(projectRoot, 'seal.lock'), 'utf8'));
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new SealwrapperError('seal.lock is required; run sealwrapper init or sealwrapper lock update', 2);
    throw new SealwrapperError(`seal.lock is not valid JSON: ${error.message}`, 2);
  }
  return validateSealLock(raw, overlayRoot);
}

export function renderSealLock(target: any): string {
  return `${JSON.stringify({ lockVersion: 1, targets: { '1.6.0': target } }, null, 2)}\n`;
}
