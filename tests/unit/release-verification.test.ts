import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { renderSealLock } from '../../src/lock.ts';
import { pinnedTarget } from '../../src/pinned-target.ts';
import { verifyReleaseBundle, writeReleaseProvenance } from '../../src/release.ts';

function config(): any {
  return {
    schemaVersion: 2,
    package: { name: 'Verification Fixture', version: '1.0.0', authors: ['Tester'], license: 'MIT', description: '', homepage: '' },
    sealDice: { buildTarget: ['1.6.0'], defaultTarget: '1.6.0' },
    release: { directory: 'release', checksum: 'sha256', artifactPolicy: { forbiddenPaths: [], forbiddenExtensions: [] } },
    sealpack: { packageId: 'tester/verification-fixture', minSealDice: '1.6.0', contents: { decks: { source: 'content/decks' } }, dependencies: {}, permissions: { network: false, networkHosts: [], acknowledgeUnrestrictedNetwork: false, fileRead: [], fileWrite: [], dangerous: false, httpServer: false, ipc: [] }, readme: 'README.md', assets: [], store: { category: 'rules', icon: '', banner: '', screenshots: [] } },
  };
}

test('release verification binds archive, lock and an external Ed25519 trust anchor', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-release-verify-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = join(root, 'release');
  const artifact = join(release, 'fixture@1.0.0.sealpack');
  const privateKey = join(root, 'release-private.pem');
  const publicKey = join(root, 'release-public.pem');
  const wrongKey = join(root, 'wrong-public.pem');
  const pair = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519');
  await mkdir(release, { recursive: true });
  await Promise.all([
    writeFile(artifact, 'release archive bytes'),
    writeFile(join(root, 'seal.lock'), renderSealLock(pinnedTarget)),
    writeFile(privateKey, pair.privateKey.export({ format: 'pem', type: 'pkcs8' })),
    writeFile(publicKey, pair.publicKey.export({ format: 'pem', type: 'spki' })),
    writeFile(wrongKey, other.publicKey.export({ format: 'pem', type: 'spki' })),
  ]);
  const provenance = await writeReleaseProvenance({ projectRoot: root, artifact, config: config(), target: pinnedTarget, signingKeyPath: privateKey, signingKeyId: 'fixture-key' });
  const verified = await verifyReleaseBundle({ artifact, provenance, trustedKeyPath: publicKey, trustedKeyId: 'fixture-key', lockPath: join(root, 'seal.lock') });
  assert.match(verified.artifactSha256, /^sha256:/);
  await assert.rejects(
    () => verifyReleaseBundle({ artifact, provenance, trustedKeyPath: wrongKey, lockPath: join(root, 'seal.lock') }),
    /does not match the caller-supplied trusted key/,
  );
});
