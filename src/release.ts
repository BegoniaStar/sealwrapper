import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { access, link, lstat, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { SealwrapperError } from './errors.ts';
import { overlayDigest } from './lock.ts';
import { verifyTargetTrust } from './trust.ts';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function releaseTimestamp() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (!epoch) return '1980-01-01T00:00:00.000Z';
  if (!/^\d+$/.test(epoch)) throw new Error('SOURCE_DATE_EPOCH must be an integer');
  return new Date(Number(epoch) * 1000).toISOString();
}

type LockBinding = { digest: string };

/** Read and bind the exact lock bytes used to produce a release. */
async function lockBinding(projectRoot: string, target: any): Promise<LockBinding> {
  try { verifyTargetTrust(target); } catch (error) { throw new SealwrapperError(`Release provenance target trust verification failed: ${(error as Error).message}`, 3); }
  const path = join(projectRoot, 'seal.lock');
  let stat;
  try { stat = await lstat(path); } catch (error: any) {
    throw new SealwrapperError(`seal.lock is required for release provenance: ${error?.message ?? error}`, 3);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new SealwrapperError('seal.lock must be a regular, non-symbolic-link file for release provenance', 3);
  let bytes: Buffer;
  try { bytes = await readFile(path); } catch (error: any) {
    throw new SealwrapperError(`Unable to read seal.lock for release provenance: ${error?.message ?? error}`, 3);
  }
  let raw: any;
  try { raw = JSON.parse(bytes.toString('utf8')); } catch (error: any) {
    throw new SealwrapperError(`seal.lock is not valid JSON for release provenance: ${error?.message ?? error}`, 3);
  }
  const locked = raw?.targets?.['1.6.0'];
  if (!raw || raw.lockVersion !== 1 || !raw.targets || Object.keys(raw.targets).length !== 1 || !locked?.core || !locked?.testOverlay) throw new SealwrapperError('seal.lock has no exact 1.6.0 target for release provenance', 3);
  const coreFields = ['version', 'source', 'commit', 'runtimeVersion', 'sourceDeclaredVersion', 'releaseArtifactSha256'];
  for (const field of coreFields) {
    if (target?.core?.[field] !== locked.core[field]) throw new SealwrapperError(`Release provenance target does not match seal.lock core.${field}`, 3);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(locked.core.releaseArtifactSha256)) throw new SealwrapperError('seal.lock core.releaseArtifactSha256 is invalid for release provenance', 3);
  const overlayFields = ['id', 'protocol', 'goVersion', 'capabilitiesSha256'];
  for (const field of overlayFields) {
    if (target?.testOverlay?.[field] !== locked.testOverlay[field]) throw new SealwrapperError(`Release provenance target does not match seal.lock testOverlay.${field}`, 3);
  }
  if (!Array.isArray(locked.testOverlay.patches) || !Array.isArray(target?.testOverlay?.patches) || stable(target.testOverlay.patches) !== stable(locked.testOverlay.patches)) {
    throw new SealwrapperError('Release provenance target overlay patches do not match seal.lock', 3);
  }
  const digest = overlayDigest(locked.testOverlay.patches);
  if (target.testOverlay.digest !== digest) throw new SealwrapperError('Release provenance target overlay digest does not match seal.lock', 3);
  if (target?.trust?.activeKeyId !== locked?.trust?.activeKeyId) throw new SealwrapperError('Release provenance target trust key does not match seal.lock', 3);
  // Bind all remaining signed lock fields as well (mirror policy, trust keys,
  // rotations, and capability declarations), not only the values rendered in
  // the human-readable manifest.  The loader adds the computed overlay digest
  // to its target, so add the same derived field to the raw lock shape first.
  const normalizedLocked = { ...locked, testOverlay: { ...locked.testOverlay, digest } };
  if (stable(target) !== stable(normalizedLocked)) throw new SealwrapperError('Release provenance target does not match the complete seal.lock descriptor', 3);
  return { digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
}

async function releaseSignature(manifest: any, signingKeyPath?: string, signingKeyId?: string) {
  if (!signingKeyPath) return undefined;
  const privateKey = createPrivateKey(await readFile(signingKeyPath));
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
  return { algorithm: 'ed25519', keyId: signingKeyId || 'local-ed25519', publicKey, value: sign(null, Buffer.from(stable(manifest), 'utf8'), privateKey).toString('base64') };
}

/**
 * Create all provenance bytes before publishing anything into release/. This
 * deliberately parses the private key here: a malformed signing key cannot
 * leave a newly-created archive or checksum behind.
 */
export async function renderReleaseProvenance({ projectRoot, artifact, config, target, signingKeyPath, signingKeyId }: { projectRoot: string; artifact: string; config: any; target: any; signingKeyPath?: string; signingKeyId?: string }): Promise<Buffer> {
  const lock = await lockBinding(projectRoot, target);
  const archive = await readFile(artifact);
  const manifest = {
    format: 'sealwrapper.release/v1',
    generatedAt: releaseTimestamp(),
    artifact: { name: basename(artifact), sha256: `sha256:${createHash('sha256').update(archive).digest('hex')}`, bytes: archive.length },
    package: { id: config.sealpack.packageId, name: config.package.name, version: config.package.version },
    target: '1.6.0',
    lock: { sha256: lock.digest },
    core: { source: target.core.source ?? null, commit: target.core.commit, runtimeVersion: target.core.runtimeVersion, sourceDeclaredVersion: target.core.sourceDeclaredVersion ?? null, releaseArtifactSha256: target.core.releaseArtifactSha256 ?? null },
    overlay: { id: target.testOverlay.id, digest: target.testOverlay.digest, protocol: target.testOverlay.protocol, capabilitiesSha256: target.testOverlay.capabilitiesSha256, patches: target.testOverlay.patches ?? [], trustKeyId: target.trust?.activeKeyId ?? null, nonProductionEquivalent: false },
  };
  const signature = await releaseSignature(manifest, signingKeyPath, signingKeyId);
  const signed = signature ? { ...manifest, signature } : manifest;
  return Buffer.from(`${stable(signed)}\n`, 'utf8');
}

/** Publish a complete release set without overwriting any existing artifact.
 *
 * Each file is first made beneath .seal. `link` is atomic and fails if the
 * target already exists, so a concurrent publisher cannot silently replace a
 * release. If publishing a later file fails, every new link made by this call
 * is removed again. This is intentionally stricter than replacing a prior
 * versioned release: authors must change package.version to publish anew.
 */
export async function publishReleaseFiles({ releaseDirectory, files }: { releaseDirectory: string; files: { source: string; name: string }[] }): Promise<string[]> {
  const safe = files.map((file) => {
    if (basename(file.name) !== file.name || !file.name || file.name.includes('..')) throw new Error(`Unsafe release filename: ${file.name}`);
    return { ...file, destination: join(releaseDirectory, file.name) };
  });
  if (new Set(safe.map((file) => file.name)).size !== safe.length) throw new Error('Release files contain duplicate names');
  for (const file of safe) {
    try { await access(file.destination); throw new Error(`Release artifact already exists: ${file.destination}`); }
    catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  }
  let madeDirectory = false;
  try {
    try { await access(releaseDirectory); } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(releaseDirectory, { recursive: true, mode: 0o755 });
      madeDirectory = true;
    }
    const published: string[] = [];
    try {
      for (const file of safe) {
        await link(file.source, file.destination);
        published.push(file.destination);
      }
      for (const file of safe) await unlink(file.source);
      return published;
    } catch (error) {
      await Promise.all(published.map((path) => unlink(path).catch(() => {})));
      throw error;
    }
  } catch (error) {
    if (madeDirectory) await rm(releaseDirectory, { force: true, recursive: false }).catch(() => {});
    throw error;
  }
}

export async function writeReleaseProvenance({ projectRoot, artifact, config, target, signingKeyPath, signingKeyId }: { projectRoot: string; artifact: string; config: any; target: any; signingKeyPath?: string; signingKeyId?: string }) {
  const data = await renderReleaseProvenance({ projectRoot, artifact, config, target, signingKeyPath, signingKeyId });
  const path = join(dirname(artifact), `${basename(artifact)}.release.json`);
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, data, { mode: 0o644 });
  // This compatibility helper is for callers that already own the destination
  // directory. The CLI uses publishReleaseFiles for its all-or-nothing path.
  await link(temporary, path);
  await unlink(temporary);
  return path;
}
