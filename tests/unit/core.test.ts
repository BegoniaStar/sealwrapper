import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { describeLockDiff, overlayDigest, renderSealLock, validateSealLock } from '../../src/lock.ts';
import { pinnedTarget } from '../../src/pinned-target.ts';
import { canonicalOverlayTrustDescriptor, verifyTargetTrust } from '../../src/trust.ts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function lockFor(target: any) {
  return JSON.parse(renderSealLock(target));
}

test('pinned 1.6.0 provenance keeps distribution runtime distinct from source declaration', () => {
  assert.equal(pinnedTarget.core.commit, 'b06a2d92a7af0b8b33be33390206297edf29c7bd');
  assert.equal(pinnedTarget.core.runtimeVersion, '1.6.0+20260726');
  assert.equal(pinnedTarget.core.sourceDeclaredVersion, '1.5.1-dev');
  assert.equal(pinnedTarget.testOverlay.goVersion, '1.25.0');
  assert.equal(pinnedTarget.testOverlay.protocol, 'sealwrapper.core-bridge/v3');
  assert.equal(pinnedTarget.testOverlay.capabilities.limits.maxCompressionRatio, 100);
});

test('lock update diff exposes every release-relevant contract change', () => {
  const old = structuredClone(pinnedTarget);
  old.core.commit = '0'.repeat(40);
  old.testOverlay.capabilities.limits.maxCompressionRatio = 50;
  old.testOverlay.capabilitiesSha256 = 'sha256:old';
  old.testOverlay.patches[0].sha256 = 'f'.repeat(64);
  const lines = describeLockDiff(lockFor(old), lockFor(pinnedTarget));
  assert.ok(lines.some((line) => line.startsWith('core.commit:')));
  assert.ok(lines.some((line) => line.startsWith('overlay.patch[1]:')));
  assert.ok(lines.some((line) => line.startsWith('capability.limits.maxCompressionRatio:')));
});

test('lock validation accepts the registered target and authenticated test-only overlay', async () => {
  const patch = await readFile(join(process.cwd(), pinnedTarget.testOverlay.patches[0].path));
  const lock = lockFor(pinnedTarget);
  const validated = validateSealLock(lock, process.cwd());
  assert.equal(validated.targets['1.6.0'].testOverlay.digest, overlayDigest(validated.targets['1.6.0'].testOverlay.patches));
  assert.match(patch.toString('utf8'), /^diff --git a\/dice\/zz_sealwrapper_bridge_test\.go b\/dice\/zz_sealwrapper_bridge_test\.go/m);
  assert.doesNotMatch(patch.toString('utf8'), /^--- a\/dice\/(?!zz_sealwrapper_bridge_test\.go)/m);
});

test('lock validation rejects a changed patch hash or non-test overlay path', () => {
  const tampered = structuredClone(pinnedTarget);
  tampered.testOverlay.patches[0].sha256 = '0'.repeat(64);
  assert.throws(() => validateSealLock(lockFor(tampered), process.cwd()), /sha256/i);
  const nonTest = structuredClone(pinnedTarget);
  nonTest.testOverlay.patches[0].path = 'patches/sealdice-core/1.6.0/0001-loader-change.patch';
  assert.throws(() => validateSealLock(lockFor(nonTest), process.cwd()), /test-only/i);
});

test('P2 lock trust verifies an Ed25519-signed overlay descriptor and locked mirror policy', () => {
  assert.equal(verifyTargetTrust(pinnedTarget), pinnedTarget.trust.activeKeyId);
  const tampered = structuredClone(pinnedTarget);
  tampered.core.commit = '0'.repeat(40);
  assert.throws(() => verifyTargetTrust(tampered), /signature/i);
  const badMirror = structuredClone(pinnedTarget);
  badMirror.core.mirrors = ['https://example.invalid/sealdice-core'];
  assert.throws(() => verifyTargetTrust(badMirror), /mirror/i);
});

test('P2 trust accepts an authenticated Ed25519 key rotation before a new overlay signature', () => {
  const oldPair = generateKeyPairSync('ed25519');
  const newPair = generateKeyPairSync('ed25519');
  const oldKey = oldPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const newKey = newPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const target = structuredClone(pinnedTarget) as any;
  target.trust.activeKeyId = 'new';
  target.trust.keys = [{ id: 'old', algorithm: 'ed25519', publicKey: oldKey }, { id: 'new', algorithm: 'ed25519', publicKey: newKey }];
  const notBefore = '2026-08-01T00:00:00.000Z';
  target.trust.rotations = [{ from: 'old', to: 'new', notBefore, signature: sign(null, Buffer.from(canonical({ format: 'sealwrapper.key-rotation/v1', from: 'old', to: 'new', notBefore, publicKey: newKey })), oldPair.privateKey).toString('base64') }];
  target.trust.overlaySignature = { keyId: 'new', algorithm: 'ed25519', value: '' };
  target.trust.overlaySignature.value = sign(null, Buffer.from(canonicalOverlayTrustDescriptor(target)), newPair.privateKey).toString('base64');
  assert.equal(verifyTargetTrust(target), 'new');
});
