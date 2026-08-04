import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sha256(data) {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

async function main() {
  const releasePath = await mkdtemp(join(projectRoot, 'artifacts-release-test-'));
  const releaseDirectory = basename(releasePath);
  const previous = process.env.SEALWRAPPER_RELEASE_DIRECTORY;
  process.env.SEALWRAPPER_RELEASE_DIRECTORY = releaseDirectory;

  try {
    const { prepareRelease } = await import('./prepare-release.mjs');
    const { archive, checksum, sbom, manifest, release } = await prepareRelease();
    const archiveBytes = await readFile(archive);
    const archiveName = basename(archive);
    const sbomData = JSON.parse(await readFile(sbom, 'utf8'));
    const manifestData = JSON.parse(await readFile(manifest, 'utf8'));

    await Promise.all([access(archive), access(checksum), access(sbom), access(manifest)]);
    assert.equal(await readFile(checksum, 'utf8'), `${sha256(archiveBytes).slice('sha256:'.length)}  ${archiveName}\n`);
    assert.equal(sbomData.bomFormat, 'CycloneDX');
    assert.equal(sbomData.metadata.component.name, 'sealwrapper');
    assert.equal(sbomData.metadata.component.version, manifestData.package.version);
    assert.deepEqual(manifestData, release);
    assert.equal(manifestData.format, 'sealwrapper.tool-release/v1');
    assert.equal(manifestData.artifacts[0].name, archiveName);
    assert.equal(manifestData.artifacts[0].bytes, archiveBytes.length);
    assert.equal(manifestData.artifacts[0].sha256, sha256(archiveBytes));
    assert.equal(manifestData.artifacts[1].sha256, sha256(await readFile(checksum)));
    assert.equal(manifestData.artifacts[2].name, basename(sbom));
    assert.equal(manifestData.artifacts[2].format, 'CycloneDX');
    assert.equal(manifestData.artifacts[2].sha256, sha256(await readFile(sbom)));
    process.stdout.write(`Release artifact verification passed: ${archiveName}\n`);
  } finally {
    if (previous === undefined) delete process.env.SEALWRAPPER_RELEASE_DIRECTORY;
    else process.env.SEALWRAPPER_RELEASE_DIRECTORY = previous;
    await rm(releasePath, { force: true, recursive: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
