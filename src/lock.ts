import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { canonicalJson, capabilitiesDigest, type BridgeCapabilities, diffCapabilities } from './capabilities.ts';
import { invariant, SealwrapperError } from './errors.ts';
import { compareTargetIds, targetRegistry, targetRegistryVersion, type TargetDescriptor } from './pinned-target.ts';
import { verifyTargetTrust } from './trust.ts';

export type LockedTarget = TargetDescriptor & {
  testOverlay: TargetDescriptor['testOverlay'] & { digest: string };
};

export type SealLock = {
  lockVersion: 2;
  registryVersion: number;
  buildTargets: string[];
  defaultTarget: string;
  targets: Record<string, LockedTarget>;
};

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneWithoutDerivedFields(target: Record<string, any>): Record<string, any> {
  const clone = structuredClone(target);
  if (isRecord(clone.testOverlay)) delete clone.testOverlay.digest;
  return clone;
}

function targetComparable(target: Record<string, any>, id: string): Record<string, any> {
  const clone = cloneWithoutDerivedFields(target);
  if (clone.id === undefined) clone.id = id;
  return clone;
}

export function overlayDigest(patches: readonly { path: string; sha256: string }[]): string {
  return `sha256:${createHash('sha256').update(canonicalJson(patches.map((patch) => ({ path: patch.path, sha256: patch.sha256 })))).digest('hex')}`;
}

function patchPath(root: string, patch: any, targetId: string): string {
  invariant(typeof patch.path === 'string' && patch.path.startsWith(`patches/sealdice-core/${targetId}/`) && patch.path.endsWith('.patch') && !patch.path.includes('..') && !isAbsolute(patch.path), 'test-only overlay patch path is invalid');
  invariant(/test-only/.test(patch.path), 'test-only overlay patch filename must state test-only intent');
  return join(root, patch.path);
}

function validateTarget(target: any, root: string, expectedId: string, registry: Readonly<Record<string, TargetDescriptor>>): LockedTarget {
  invariant(isRecord(target), `seal.lock target ${expectedId} must be an object`);
  invariant(registry[expectedId] !== undefined, `seal.lock target ${expectedId} is not included in this sealwrapper target registry`);
  const registered = registry[expectedId];
  invariant(registered.id === expectedId, `sealwrapper target registry descriptor ${expectedId} has a mismatched id`);
  invariant(target.id === undefined || target.id === expectedId, `seal.lock target id must be ${expectedId}`);
  const core = target.core;
  invariant(isRecord(core), `seal.lock target ${expectedId}.core must be an object`);
  invariant(core.version === expectedId && /^[0-9a-f]{40}$/.test(core.commit), `seal.lock target ${expectedId} core version and commit must be locked`);
  invariant(typeof core.source === 'string' && /^https:\/\//.test(core.source), `seal.lock target ${expectedId} core source must be HTTPS`);
  invariant(Array.isArray(core.mirrors) && core.mirrors.length > 0 && core.mirrors.every((mirror: unknown) => typeof mirror === 'string' && /^https:\/\//.test(mirror)), `seal.lock target ${expectedId} core mirrors must be HTTPS URLs`);
  invariant(typeof core.sourceDeclaredVersion === 'string' && core.sourceDeclaredVersion.length > 0, `seal.lock target ${expectedId} source declaration must be locked`);
  invariant(typeof core.runtimeVersion === 'string' && core.runtimeVersion.length > 0, `seal.lock target ${expectedId} runtime version must be locked`);
  invariant(/^sha256:[0-9a-f]{64}$/.test(core.releaseArtifactSha256), `seal.lock target ${expectedId} releaseArtifactSha256 must be sha256`);

  const overlay = target.testOverlay;
  invariant(isRecord(overlay), `seal.lock target ${expectedId}.testOverlay must be an object`);
  invariant(typeof overlay.id === 'string' && overlay.id.length > 0 && typeof overlay.protocol === 'string' && overlay.protocol.length > 0 && typeof overlay.goVersion === 'string' && overlay.goVersion.length > 0, `seal.lock target ${expectedId} bridge identity must be locked`);
  invariant(/^sha256:[0-9a-f]{64}$/.test(overlay.capabilitiesSha256), `seal.lock target ${expectedId} capabilitiesSha256 must be sha256`);
  invariant(isRecord(overlay.capabilities), `seal.lock target ${expectedId} must record bridge capabilities`);
  invariant(capabilitiesDigest(overlay.capabilities as BridgeCapabilities) === overlay.capabilitiesSha256, `seal.lock target ${expectedId} capabilitiesSha256 does not match its canonical capability contract`);
  invariant(Array.isArray(overlay.patches) && overlay.patches.length > 0, `seal.lock target ${expectedId} requires an ordered test-only overlay patch series`);
  for (const patch of overlay.patches) {
    const source = patchPath(root, patch, expectedId);
    invariant(/^[0-9a-f]{64}$/.test(patch.sha256), `seal.lock target ${expectedId} overlay patch sha256 must be hexadecimal`);
    let data: Buffer;
    try {
      data = readFileSync(source);
    } catch (error) {
      throw new SealwrapperError(`Unable to read locked overlay patch ${patch.path}: ${(error as Error).message}`, 3);
    }
    const actual = createHash('sha256').update(data).digest('hex');
    invariant(actual === patch.sha256, `Locked overlay patch sha256 mismatch for ${patch.path}`, 3);
    const diff = data.toString('utf8');
    invariant(/^diff --git a\/dice\/[^\n]+_test\.go b\/dice\/[^\n]+_test\.go/m.test(diff), `Overlay patch is not test-only: ${patch.path}`, 3);
    invariant(!/^--- a\/(?!dice\/[^\n]+_test\.go$)/m.test(diff) && !/^\+\+\+ b\/(?!dice\/[^\n]+_test\.go$)/m.test(diff), `Overlay patch changes production files: ${patch.path}`, 3);
  }
  const resolved = {
    ...target,
    id: expectedId,
    testOverlay: { ...overlay, digest: overlayDigest(overlay.patches) },
  } as LockedTarget;
  verifyTargetTrust(resolved);
  invariant(canonicalJson(targetComparable(resolved, expectedId)) === canonicalJson(targetComparable(registered, expectedId)), `seal.lock target ${expectedId} does not match the signed registry descriptor`, 3);
  return resolved;
}

function validateTargetIds(ids: unknown, label: string, registry: Readonly<Record<string, TargetDescriptor>>): string[] {
  invariant(Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === 'string' && id.length > 0), `${label} must be a non-empty target ID array`);
  const result = ids as string[];
  invariant(new Set(result).size === result.length, `${label} must not contain duplicate target IDs`);
  for (const id of result) invariant(registry[id] !== undefined, `${label} contains unknown target ${id}`);
  return [...result];
}

/** Render a reviewable old/new lock change summary without mutating either. */
export function describeLockDiff(previous: unknown, next: any): string[] {
  const oldTargets = isRecord(previous) && isRecord(previous.targets) ? previous.targets : {};
  const newTargets = next.targets;
  const ids = [...new Set([...Object.keys(oldTargets), ...Object.keys(newTargets)])].sort();
  const lines: string[] = [];
  const oldBuildTargets = isRecord(previous) && Array.isArray(previous.buildTargets) ? previous.buildTargets : undefined;
  const newBuildTargets = Array.isArray(next.buildTargets) ? next.buildTargets : undefined;
  if (canonicalJson(oldBuildTargets) !== canonicalJson(newBuildTargets)) lines.push(`buildTargets: ${oldBuildTargets ? oldBuildTargets.join(', ') : '<none>'} -> ${newBuildTargets?.join(', ') ?? '<none>'}`);
  const oldDefaultTarget = isRecord(previous) && typeof previous.defaultTarget === 'string' ? previous.defaultTarget : undefined;
  const newDefaultTarget = typeof next.defaultTarget === 'string' ? next.defaultTarget : undefined;
  if (oldDefaultTarget !== newDefaultTarget) lines.push(`defaultTarget: ${oldDefaultTarget ?? '<none>'} -> ${newDefaultTarget ?? '<none>'}`);
  const oldRegistryVersion = isRecord(previous) && typeof previous.registryVersion === 'number' ? previous.registryVersion : undefined;
  const newRegistryVersion = typeof next.registryVersion === 'number' ? next.registryVersion : undefined;
  if (oldRegistryVersion !== newRegistryVersion) lines.push(`registryVersion: ${oldRegistryVersion ?? '<none>'} -> ${newRegistryVersion ?? '<none>'}`);
  const compare = (id: string, label: string, left: unknown, right: unknown) => {
    if (left !== right) lines.push(`${ids.length === 1 ? '' : `${id} `}${label}: ${typeof left === 'string' ? left : '<none>'} -> ${typeof right === 'string' ? right : '<none>'}`);
  };
  for (const id of ids) {
    const oldTarget = isRecord(oldTargets[id]) ? oldTargets[id] : undefined;
    const newTarget = isRecord(newTargets[id]) ? newTargets[id] : undefined;
    if (!oldTarget) {
      lines.push(`${id}: added target`);
      continue;
    }
    if (!newTarget) {
      lines.push(`${id}: removed target`);
      continue;
    }
    const oldCore = isRecord(oldTarget.core) ? oldTarget.core : {};
    const newCore = isRecord(newTarget.core) ? newTarget.core : {};
    const oldOverlay = isRecord(oldTarget.testOverlay) ? oldTarget.testOverlay : {};
    const newOverlay = isRecord(newTarget.testOverlay) ? newTarget.testOverlay : {};
    compare(id, 'core.version', oldCore.version, newCore.version);
    compare(id, 'core.commit', oldCore.commit, newCore.commit);
    compare(id, 'core.runtimeVersion', oldCore.runtimeVersion, newCore.runtimeVersion);
    compare(id, 'core.releaseArtifactSha256', oldCore.releaseArtifactSha256, newCore.releaseArtifactSha256);
    compare(id, 'overlay.protocol', oldOverlay.protocol, newOverlay.protocol);
    compare(id, 'overlay.capabilitiesSha256', oldOverlay.capabilitiesSha256, newOverlay.capabilitiesSha256);
    const oldPatches = Array.isArray(oldOverlay.patches) ? oldOverlay.patches : [];
    const newPatches = Array.isArray(newOverlay.patches) ? newOverlay.patches : [];
    const count = Math.max(oldPatches.length, newPatches.length);
    for (let index = 0; index < count; index += 1) {
      const left = oldPatches[index], right = newPatches[index];
      if (canonicalJson(left) !== canonicalJson(right)) lines.push(`${ids.length === 1 ? '' : `${id} `}overlay.patch[${index + 1}]: ${left ? `${left.path}@${left.sha256}` : '<none>'} -> ${right ? `${right.path}@${right.sha256}` : '<none>'}`);
    }
    lines.push(...diffCapabilities(oldOverlay.capabilities ?? {}, newOverlay.capabilities ?? {}).map((line) => `${ids.length === 1 ? '' : `${id} `}${line}`));
  }
  return lines.length ? lines : ['No lock contract changes.'];
}

export function validateSealLock(raw: unknown, overlayRoot: string, registry: Readonly<Record<string, TargetDescriptor>> = targetRegistry): SealLock {
  invariant(isRecord(raw) && raw.lockVersion === 2 && isRecord(raw.targets), 'seal.lock must use lockVersion: 2');
  invariant(raw.registryVersion === targetRegistryVersion, `seal.lock.registryVersion must be ${targetRegistryVersion}`);
  const buildTargets = validateTargetIds(raw.buildTargets, 'seal.lock.buildTargets', registry);
  invariant(typeof raw.defaultTarget === 'string' && buildTargets.includes(raw.defaultTarget), 'seal.lock.defaultTarget must be one of seal.lock.buildTargets');
  const keys = Object.keys(raw.targets);
  invariant(keys.length === buildTargets.length && keys.every((id) => buildTargets.includes(id)), 'seal.lock.targets must exactly match seal.lock.buildTargets');
  const targets: Record<string, LockedTarget> = {};
  for (const id of buildTargets) targets[id] = validateTarget(raw.targets[id], overlayRoot, id, registry);
  return { lockVersion: 2, registryVersion: targetRegistryVersion, buildTargets, defaultTarget: raw.defaultTarget, targets };
}

export async function loadSealLock(projectRoot: string, overlayRoot: string): Promise<SealLock> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolve(projectRoot, 'seal.lock'), 'utf8'));
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new SealwrapperError('seal.lock is required; run sealwrapper init or sealwrapper lock update', 2);
    throw new SealwrapperError(`seal.lock is not valid JSON: ${error.message}`, 2);
  }
  return validateSealLock(raw, overlayRoot);
}

export function lockTargetIds(lock: Pick<SealLock, 'buildTargets' | 'targets'>): string[] {
  return [...lock.buildTargets];
}

export function lockDefaultTarget(lock: Pick<SealLock, 'defaultTarget' | 'buildTargets' | 'targets'>): string {
  return lock.defaultTarget;
}

export function lockedTarget(lock: SealLock, targetId?: string): LockedTarget {
  const id = targetId ?? lockDefaultTarget(lock);
  const target = lock.targets[id];
  if (!target) throw new SealwrapperError(`seal.lock does not contain target ${id}`, 2);
  return target;
}

function renderInput(input: TargetDescriptor | Record<string, TargetDescriptor>, buildTargets?: readonly string[], defaultTarget?: string) {
  if (isRecord(input) && isRecord((input as any).core)) {
    const target = input as TargetDescriptor;
    const id = target.id || target.core.version;
    const selectedDefault = defaultTarget ?? id;
    invariant(selectedDefault === id, 'seal.lock defaultTarget must match the single rendered target');
    return { targets: { [id]: target }, buildTargets: [id], defaultTarget: selectedDefault };
  }
  const targets = input as Record<string, TargetDescriptor>;
  const ids = [...(buildTargets ?? Object.keys(targets))].sort(compareTargetIds);
  invariant(ids.length > 0, 'seal.lock requires at least one target');
  for (const id of ids) invariant(targets[id] !== undefined, `seal.lock target ${id} is missing from the descriptor map`);
  const selectedDefault = defaultTarget ?? ids[0];
  invariant(ids.includes(selectedDefault), 'seal.lock defaultTarget must be one of the rendered targets');
  return { targets: Object.fromEntries(ids.map((id) => [id, targets[id]])), buildTargets: ids, defaultTarget: selectedDefault };
}

/** Render the current lock schema from either one descriptor or a target map. */
export function renderSealLock(input: TargetDescriptor | Record<string, TargetDescriptor>, buildTargets?: readonly string[], defaultTarget?: string): string {
  const rendered = renderInput(input, buildTargets, defaultTarget);
  return `${JSON.stringify({ lockVersion: 2, registryVersion: targetRegistryVersion, buildTargets: rendered.buildTargets, defaultTarget: rendered.defaultTarget, targets: rendered.targets }, null, 2)}\n`;
}
