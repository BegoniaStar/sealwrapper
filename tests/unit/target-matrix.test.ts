import assert from 'node:assert/strict';
import test from 'node:test';

import { configuredTargetIds, validateProjectConfig } from '../../src/config.ts';
import { describeLockDiff, renderSealLock, validateSealLock } from '../../src/lock.ts';
import {
  compareTargetIds,
  defaultTargetId,
  minimumTargetId,
  pinnedTarget,
  targetRegistry,
} from '../../src/pinned-target.ts';

function targetConfig(buildTarget: string[] = ['1.7.0', '1.6.0']): any {
  return {
    schemaVersion: 2,
    package: { name: 'Matrix fixture', version: '1.0.0', authors: ['Tester'], license: 'MIT', description: '', homepage: '' },
    sealDice: { buildTarget, defaultTarget: buildTarget[0] },
    release: { directory: 'release', checksum: 'sha256', artifactPolicy: { forbiddenPaths: [], forbiddenExtensions: [] } },
    sealpack: {
      packageId: 'tester/matrix-fixture',
      minSealDice: '1.6.0',
      contents: { decks: { source: 'content/decks' } },
      dependencies: {},
      permissions: { network: false, networkHosts: [], acknowledgeUnrestrictedNetwork: false, fileRead: [], fileWrite: [], dangerous: false, httpServer: false, ipc: [] },
      readme: 'README.md',
      assets: [],
      store: { category: 'rules', icon: '', banner: '', screenshots: [] },
    },
  };
}

function syntheticTarget(id: string): any {
  return {
    ...pinnedTarget,
    id,
    core: { ...pinnedTarget.core, version: id },
  };
}

const matrixRegistry = {
  '1.6.0': pinnedTarget,
  '1.7.0': syntheticTarget('1.7.0'),
} as const;

test('target registry is runtime-frozen and exposes a deterministic default', () => {
  assert.equal(defaultTargetId, '1.6.0');
  assert.ok(Object.isFrozen(targetRegistry));
  assert.ok(Object.isFrozen(targetRegistry[defaultTargetId]));
  assert.deepEqual(Object.keys(targetRegistry), ['1.6.0']);
});

test('SemVer target ordering derives the package minimum independently of declaration order', () => {
  assert.equal(compareTargetIds('1.7.0', '1.6.0'), 1);
  assert.equal(compareTargetIds('1.7.0-rc.1', '1.7.0'), -1);
  assert.throws(() => compareTargetIds('01.0.0', '1.0.0'), /semantic version/);
  assert.equal(minimumTargetId(['1.7.0', '1.6.0']), '1.6.0');
  assert.throws(() => minimumTargetId([]), /at least one/i);
});

test('schema v2 accepts a target matrix and requires its minimum target as minSealDice', () => {
  const config = targetConfig();
  const validated = validateProjectConfig(config, matrixRegistry);
  assert.deepEqual(configuredTargetIds(validated), ['1.6.0', '1.7.0']);

  const badMinimum = targetConfig();
  badMinimum.sealpack.minSealDice = '1.7.0';
  assert.throws(() => validateProjectConfig(badMinimum, matrixRegistry), /lowest selected target/);

  const duplicate = targetConfig(['1.6.0', '1.6.0']);
  assert.throws(() => validateProjectConfig(duplicate, matrixRegistry), /duplicate/);

  const badDefault = targetConfig();
  badDefault.sealDice.defaultTarget = '1.6.0';
  badDefault.sealDice.buildTarget = ['1.7.0'];
  assert.throws(() => validateProjectConfig(badDefault, matrixRegistry), /defaultTarget.*included/);

  const unknown = targetConfig(['1.8.0']);
  assert.throws(() => validateProjectConfig(unknown, matrixRegistry), /not included.*registry/);

  const legacyField = targetConfig();
  legacyField.sealDice.compatibilityTargets = ['1.6.0'];
  assert.throws(() => validateProjectConfig(legacyField, matrixRegistry), /compatibilityTargets.*unsupported/);
});

test('schema v1 is rejected instead of being interpreted as a target matrix', () => {
  const config = targetConfig();
  config.schemaVersion = 1;
  assert.throws(() => validateProjectConfig(config, matrixRegistry), /Only schemaVersion: 2 is supported/);
});

test('target-aware lock rendering records the complete matrix and default target', () => {
  const rendered = JSON.parse(renderSealLock(matrixRegistry, ['1.7.0', '1.6.0'], '1.7.0'));
  assert.equal(rendered.lockVersion, 2);
  assert.equal(rendered.registryVersion, 1);
  assert.deepEqual(rendered.buildTargets, ['1.6.0', '1.7.0']);
  assert.equal(rendered.defaultTarget, '1.7.0');
  assert.deepEqual(Object.keys(rendered.targets), ['1.6.0', '1.7.0']);
});

test('lock diffs include target-set metadata changes as reviewable lines', () => {
  const previous = { lockVersion: 2, registryVersion: 1, buildTargets: ['1.6.0'], defaultTarget: '1.6.0', targets: { '1.6.0': pinnedTarget } };
  const next = { ...previous, buildTargets: ['1.6.0', '1.7.0'], defaultTarget: '1.7.0', targets: { ...previous.targets, '1.7.0': syntheticTarget('1.7.0') } };
  const diff = describeLockDiff(previous, next);
  assert.ok(diff.includes('buildTargets: 1.6.0 -> 1.6.0, 1.7.0'));
  assert.ok(diff.includes('defaultTarget: 1.6.0 -> 1.7.0'));
  assert.ok(diff.includes('1.7.0: added target'));
});

test('lock v2 rejects target-set and default mismatches before core validation', () => {
  const validShape = JSON.parse(renderSealLock({ '1.6.0': pinnedTarget }, ['1.6.0'], '1.6.0'));
  assert.throws(() => validateSealLock({ ...validShape, defaultTarget: '1.7.0' }, process.cwd()), /defaultTarget/);
  assert.throws(() => validateSealLock({ ...validShape, buildTargets: ['1.6.0', '1.7.0'] }, process.cwd()), /unknown target/);
  assert.throws(() => validateSealLock({ ...validShape, buildTargets: ['9.9.9'] }, process.cwd()), /unknown target/);
});

test('lock v1 is rejected instead of being interpreted as a target matrix', () => {
  assert.throws(() => validateSealLock({ lockVersion: 1, targets: { '1.6.0': pinnedTarget } }, process.cwd()), /lockVersion: 2/);
});
