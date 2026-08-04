import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sourceCoreReleaseArtifactPath, sourceCoreReleaseArtifactUrl, syncReleaseArtifact, verifyReleaseArtifact, type CoreReleaseArtifact } from '../../src/release-artifact.ts';

function descriptor(data: Buffer): CoreReleaseArtifact {
  return {
    version: '1.6.0',
    releaseArtifactSha256: `sha256:${createHash('sha256').update(data).digest('hex')}`,
    release: { repository: 'https://github.com/sealdice/sealdice-build', tag: 'v1.6.0' },
  };
}

async function artifactDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sealwrapper-release-artifact-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('release artifact URL is deterministic from signed release metadata', () => {
  const core = descriptor(Buffer.from('fixture'));
  assert.equal(
    sourceCoreReleaseArtifactUrl(core),
    'https://github.com/sealdice/sealdice-build/releases/download/v1.6.0/sealdice-core_1.6.0_linux_amd64.tar.gz',
  );
  assert.throws(
    () => sourceCoreReleaseArtifactUrl({ ...core, release: { repository: 'https://example.invalid/core', tag: 'v1.6.0' } }),
    /GitHub HTTPS repository/,
  );
});

test('release artifact cache is hashed before it can satisfy core verification', async (t) => {
  const directory = await artifactDirectory(t);
  const bytes = Buffer.from('verified upstream release artifact');
  const core = descriptor(bytes);
  const path = sourceCoreReleaseArtifactPath(directory, core);
  await writeFile(path, bytes);
  const first = await syncReleaseArtifact({
    directory,
    core,
    offline: true,
    fetchImpl: async () => { throw new Error('cache should avoid network'); },
  });
  assert.equal(first.source, 'cache');
  assert.equal(first.path, path);
  assert.equal(first.bytes, bytes.length);
  assert.deepEqual(await verifyReleaseArtifact(path, core), { sha256: core.releaseArtifactSha256, bytes: bytes.length });
});

test('a mismatched release-artifact cache is atomically replaced only after download verification', async (t) => {
  const directory = await artifactDirectory(t);
  const bytes = Buffer.from('downloaded and hash-pinned artifact');
  const core = descriptor(bytes);
  const path = sourceCoreReleaseArtifactPath(directory, core);
  await writeFile(path, 'tampered cache');
  let requests = 0;
  const result = await syncReleaseArtifact({
    directory,
    core,
    fetchImpl: async () => {
      requests += 1;
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.source, 'download');
  assert.deepEqual(await readFile(path), bytes);
});
