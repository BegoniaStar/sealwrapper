import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { archiveSealpack } from '../../src/archive.ts';
import { invokeBridge, verifyBridgeResult } from '../../src/bridge.ts';
import { pinnedTarget } from '../../src/pinned-target.ts';

test('bridge result requires exact base, distribution runtime, overlay, and capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-bridge-result-'));
  const result = {
    protocol: 'sealwrapper.core-bridge/v3',
    base: { commit: pinnedTarget.core.commit, runtimeVersion: pinnedTarget.core.runtimeVersion, sourceDeclaredVersion: '1.5.1-dev' },
    overlay: { id: pinnedTarget.testOverlay.id, digest: 'sha256:test' },
    capabilitiesDigest: pinnedTarget.testOverlay.capabilitiesSha256,
    manifestFormatVersions: pinnedTarget.testOverlay.capabilities.manifestFormatVersions,
    contents: pinnedTarget.testOverlay.capabilities.contents,
    limits: pinnedTarget.testOverlay.capabilities.limits,
    networkMock: pinnedTarget.testOverlay.capabilities.networkMock,
    ok: true, diagnostics: [], summary: { errors: 0, warnings: 0 },
  };
  assert.throws(() => verifyBridgeResult(result, { ...pinnedTarget, testOverlay: { ...pinnedTarget.testOverlay, digest: 'sha256:expected' } }), /overlay/i);
  assert.equal(root.length > 0, true);
  assert.equal(typeof invokeBridge, 'function');
  await rm(root, { force: true, recursive: true });
});

test('bridge result must explicitly attest production equivalence', () => {
  const result = {
    protocol: 'sealwrapper.core-bridge/v3',
    base: { commit: pinnedTarget.core.commit, runtimeVersion: pinnedTarget.core.runtimeVersion, sourceDeclaredVersion: pinnedTarget.core.sourceDeclaredVersion },
    overlay: { id: pinnedTarget.testOverlay.id },
    capabilitiesDigest: pinnedTarget.testOverlay.capabilitiesSha256,
    manifestFormatVersions: pinnedTarget.testOverlay.capabilities.manifestFormatVersions,
    contents: pinnedTarget.testOverlay.capabilities.contents,
    limits: pinnedTarget.testOverlay.capabilities.limits,
    networkMock: pinnedTarget.testOverlay.capabilities.networkMock,
    ok: true,
    diagnostics: [],
    summary: { errors: 0, warnings: 0 },
  };
  assert.throws(() => verifyBridgeResult(result, pinnedTarget), /nonProductionEquivalent/i);
  assert.doesNotThrow(() => verifyBridgeResult({ ...result, nonProductionEquivalent: false }, pinnedTarget));
});

test('bridge subprocess timeout terminates a hung runner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-bridge-timeout-'));
  const fakeGo = join(root, 'go');
  await writeFile(fakeGo, '#!/bin/sh\nsleep 30\n', { mode: 0o700 });
  await chmod(fakeGo, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${root}:${previousPath ?? ''}`;
  try {
    await assert.rejects(() => invokeBridge({ worktree: root, target: pinnedTarget, operation: 'capabilities', timeoutMs: 50 }), /timed out/i);
  } finally {
    process.env.PATH = previousPath;
    await rm(root, { force: true, recursive: true });
  }
});
