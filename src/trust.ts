import { createPublicKey, verify } from 'node:crypto';

import { invariant } from './errors.ts';

function record(value: unknown, label: string): Record<string, any> {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, any>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonical(source[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function keyMap(trust: Record<string, any>) {
  invariant(Array.isArray(trust.keys) && trust.keys.length > 0, 'seal.lock trust.keys must contain trusted signing keys');
  const keys = new Map<string, Record<string, any>>();
  for (const raw of trust.keys) {
    const key = record(raw, 'seal.lock trust.keys entry');
    invariant(typeof key.id === 'string' && key.id.length > 0 && !keys.has(key.id), 'seal.lock trust key IDs must be unique non-empty strings');
    invariant(key.algorithm === 'ed25519', 'seal.lock only supports ed25519 trust keys');
    invariant(typeof key.publicKey === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(key.publicKey), 'seal.lock trust key must use base64 SPKI DER');
    keys.set(key.id, key);
  }
  return keys;
}

function verifySignature(key: Record<string, any>, payload: unknown, signature: unknown, label: string) {
  invariant(typeof signature === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(signature), `${label} must be base64`);
  let publicKey: ReturnType<typeof createPublicKey>;
  try { publicKey = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' }); } catch { throw new Error(`${label} uses an invalid public key`); }
  invariant(verify(null, Buffer.from(canonical(payload), 'utf8'), publicKey, Buffer.from(signature, 'base64')), `${label} verification failed`);
}

function trustDescriptor(target: any) {
  const trust = record(target.trust, 'seal.lock target.trust');
  return {
    format: 'sealwrapper.overlay-trust/v1',
    core: {
      version: target.core?.version,
      source: target.core?.source,
      mirrors: target.core?.mirrors,
      commit: target.core?.commit,
      runtimeVersion: target.core?.runtimeVersion,
      sourceDeclaredVersion: target.core?.sourceDeclaredVersion,
      releaseArtifactSha256: target.core?.releaseArtifactSha256,
    },
    testOverlay: {
      id: target.testOverlay?.id,
      protocol: target.testOverlay?.protocol,
      goVersion: target.testOverlay?.goVersion,
      capabilitiesSha256: target.testOverlay?.capabilitiesSha256,
      patches: target.testOverlay?.patches,
    },
    trust: {
      activeKeyId: trust.activeKeyId,
      keys: trust.keys,
      rotations: trust.rotations ?? [],
      allowedMirrors: trust.allowedMirrors,
    },
  };
}

function verifyRotations(trust: Record<string, any>, keys: Map<string, Record<string, any>>) {
  const rotations = trust.rotations ?? [];
  invariant(Array.isArray(rotations), 'seal.lock trust.rotations must be an array');
  for (const raw of rotations) {
    const rotation = record(raw, 'seal.lock trust.rotations entry');
    invariant(typeof rotation.from === 'string' && typeof rotation.to === 'string' && rotation.from !== rotation.to, 'seal.lock trust rotation must name distinct from/to keys');
    const from = keys.get(rotation.from), to = keys.get(rotation.to);
    invariant(Boolean(from) && Boolean(to), 'seal.lock trust rotation references an unknown key');
    invariant(typeof rotation.notBefore === 'string' && Number.isFinite(Date.parse(rotation.notBefore)), 'seal.lock trust rotation requires an ISO-8601 notBefore timestamp');
    verifySignature(from!, { format: 'sealwrapper.key-rotation/v1', from: rotation.from, to: rotation.to, notBefore: new Date(rotation.notBefore).toISOString(), publicKey: to!.publicKey }, rotation.signature, `seal.lock trust rotation ${rotation.from}->${rotation.to} signature`);
  }
}

/** Verify the signed target/overlay descriptor before cloning any source. */
export function verifyTargetTrust(target: any): string {
  const core = record(target.core, 'seal.lock target.core');
  const trust = record(target.trust, 'seal.lock target.trust');
  const keys = keyMap(trust);
  invariant(typeof trust.activeKeyId === 'string' && keys.has(trust.activeKeyId), 'seal.lock trust.activeKeyId is not a trusted key');
  invariant(Array.isArray(core.mirrors) && core.mirrors.length > 0 && core.mirrors.every((item: unknown) => typeof item === 'string'), 'seal.lock core.mirrors must be a non-empty string array');
  invariant(Array.isArray(trust.allowedMirrors) && trust.allowedMirrors.length > 0, 'seal.lock trust.allowedMirrors must be a non-empty array');
  invariant(core.mirrors.every((mirror: string) => trust.allowedMirrors.includes(mirror)), 'seal.lock core mirror is not trusted by the signed mirror policy');
  invariant(core.mirrors.includes(core.source), 'seal.lock core source must be included in its mirror policy');
  verifyRotations(trust, keys);
  const signature = record(trust.overlaySignature, 'seal.lock trust.overlaySignature');
  invariant(signature.keyId === trust.activeKeyId, 'seal.lock overlay signature must use the active trust key');
  invariant(signature.algorithm === 'ed25519', 'seal.lock overlay signature algorithm must be ed25519');
  verifySignature(keys.get(signature.keyId)!, trustDescriptor(target), signature.value, 'seal.lock overlay signature');
  return trust.activeKeyId;
}

export function canonicalOverlayTrustDescriptor(target: any): string { return canonical(trustDescriptor(target)); }
