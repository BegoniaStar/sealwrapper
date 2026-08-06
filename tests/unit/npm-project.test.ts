import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertNpmReleaseMetadata, validateNpmProject } from '../../src/npm-project.ts';

type Manifest = Record<string, unknown>;

async function fixture(manifest?: Manifest, lockfile?: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-npm-project-'));
  if (manifest !== undefined) await writeFile(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (lockfile !== undefined) await writeFile(join(root, 'package-lock.json'), `${JSON.stringify(lockfile, null, 2)}\n`);
  return root;
}

function lockfile(manifest: Manifest, overrides: Record<string, unknown> = {}) {
  const root = {
    name: manifest.name,
    version: manifest.version,
    ...Object.fromEntries(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta'].filter((name) => manifest[name] !== undefined).map((name) => [name, manifest[name]])),
  };
  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    packages: { '': root },
    ...overrides,
  };
}

function metadataConfig() {
  return {
    package: {
      name: '展示名称',
      version: '1.2.3',
      authors: ['First Author', 'Second Author'],
      description: 'A release description.',
      homepage: 'https://example.invalid/project',
      license: 'MIT',
    },
  };
}

test('npm project validation accepts a complete lockfile that mirrors direct dependency declarations', async (t) => {
  const manifest = {
    name: 'fixture', version: '1.2.3', packageManager: 'npm@12.0.1',
    dependencies: { runtime: '1.0.0' }, devDependencies: { tool: '2.0.0' }, optionalDependencies: { optional: '3.0.0' },
    peerDependencies: { peer: '^4.0.0' }, peerDependenciesMeta: { peer: { optional: true } },
  };
  const root = await fixture(manifest, lockfile(manifest));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = await validateNpmProject(root);
  assert.equal(project?.manifest.name, 'fixture');
});

test('npm project validation rejects missing, orphaned, and stale lockfiles', async (t) => {
  const manifest = { name: 'fixture', version: '1.2.3', devDependencies: { tool: '1.0.0' } };
  const withoutLock = await fixture(manifest);
  const orphanLock = await fixture(undefined, lockfile(manifest));
  const staleLock = await fixture(manifest, lockfile(manifest, { packages: { '': { name: 'fixture', version: '1.2.3', devDependencies: { tool: '2.0.0' } } } }));
  t.after(() => Promise.all([withoutLock, orphanLock, staleLock].map((root) => rm(root, { recursive: true, force: true }))));
  await assert.rejects(() => validateNpmProject(withoutLock), /package\.json requires a committed package-lock\.json/);
  await assert.rejects(() => validateNpmProject(orphanLock), /package-lock\.json requires package\.json/);
  await assert.rejects(() => validateNpmProject(staleLock), /package-lock\.json is stale.*devDependencies/);
});

test('npm project validation rejects lock identity and package-manager mismatches', async (t) => {
  const invalidManager = { name: 'fixture', version: '1.2.3', packageManager: 'pnpm@10.0.0' };
  const staleIdentity = { name: 'fixture', version: '1.2.3' };
  const invalidManagerRoot = await fixture(invalidManager, lockfile(invalidManager));
  const staleIdentityRoot = await fixture(staleIdentity, lockfile(staleIdentity, { version: '1.2.4' }));
  t.after(() => Promise.all([invalidManagerRoot, staleIdentityRoot].map((root) => rm(root, { recursive: true, force: true }))));
  await assert.rejects(() => validateNpmProject(invalidManagerRoot), /packageManager.*npm@/);
  await assert.rejects(() => validateNpmProject(staleIdentityRoot), /package-lock\.json\.version must match/);
});

test('release metadata requires equivalent version, authors, description, homepage, and license', async (t) => {
  const manifest = {
    name: 'fixture', version: '1.2.3', author: 'First Author', contributors: [{ name: 'Second Author', email: 'second@example.invalid' }],
    description: 'A release description.', homepage: 'https://example.invalid/project', license: 'MIT',
  };
  const root = await fixture(manifest, lockfile(manifest));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = await validateNpmProject(root);
  assert.doesNotThrow(() => assertNpmReleaseMetadata(project, metadataConfig()));

  const changes: [string, (config: ReturnType<typeof metadataConfig>) => void][] = [
    ['version', (config) => { config.package.version = '1.2.4'; }],
    ['authors', (config) => { config.package.authors = ['Other Author']; }],
    ['description', (config) => { config.package.description = 'Another description.'; }],
    ['homepage', (config) => { config.package.homepage = 'https://example.invalid/other'; }],
    ['license', (config) => { config.package.license = 'Apache-2.0'; }],
  ];
  for (const [field, change] of changes) {
    const changed = metadataConfig();
    change(changed);
    assert.throws(() => assertNpmReleaseMetadata(project, changed), new RegExp(`release metadata must match.*${field}`));
  }
});
