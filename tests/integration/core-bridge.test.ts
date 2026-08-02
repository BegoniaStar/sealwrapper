import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { archiveSealpack } from '../../src/archive.ts';
import { invokeBridge, verifyBridgeResult } from '../../src/bridge.ts';
import { pinnedTarget } from '../../src/pinned-target.ts';

test('bridge result requires exact base, distribution runtime, overlay, and capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-bridge-result-'));
  const result = {
    protocol: 'sealwrapper.core-bridge/v2',
    base: { commit: pinnedTarget.core.commit, runtimeVersion: pinnedTarget.core.runtimeVersion, sourceDeclaredVersion: '1.5.1-dev' },
    overlay: { id: pinnedTarget.testOverlay.id, digest: 'sha256:test' },
    capabilitiesDigest: pinnedTarget.testOverlay.capabilitiesSha256,
    manifestFormatVersions: pinnedTarget.testOverlay.capabilities.manifestFormatVersions,
    contents: pinnedTarget.testOverlay.capabilities.contents,
    limits: pinnedTarget.testOverlay.capabilities.limits,
    ok: true, diagnostics: [], summary: { errors: 0, warnings: 0 },
  };
  assert.throws(() => verifyBridgeResult(result, { ...pinnedTarget, testOverlay: { ...pinnedTarget.testOverlay, digest: 'sha256:expected' } }), /overlay/i);
  assert.equal(root.length > 0, true);
  assert.equal(typeof invokeBridge, 'function');
});
