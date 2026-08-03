import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { access, link, lstat, mkdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SealwrapperError } from './errors.ts';
import { loadSealLock, lockedTarget, overlayDigest, type LockedTarget } from './lock.ts';
import { compareTargetIds, type TargetDescriptor } from './pinned-target.ts';
import { verifyTargetTrust } from './trust.ts';

const toolRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/**
 * Release output is a project-owned write target. A lexical `release.directory`
 * check is not sufficient because an existing path component can be a symlink
 * to an arbitrary directory. Reject such components before creating or linking
 * any artifact, and re-check after mkdir in case the directory was created by
 * this invocation.
 */
async function assertProjectReleaseDirectory(projectRoot: string, releaseDirectory: string): Promise<string> {
  const configuredRoot = resolve(projectRoot);
  const directory = resolve(releaseDirectory);
  if (!isWithin(configuredRoot, directory)) throw new SealwrapperError(`Release directory escapes the project root: ${releaseDirectory}`, 3);
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(configuredRoot);
  } catch (error: any) {
    throw new SealwrapperError(`Project root cannot be resolved for release publication: ${configuredRoot}${error?.message ? ` (${error.message})` : ''}`, 3);
  }
  let current = configuredRoot;
  for (const segment of relative(configuredRoot, directory).split(sep).filter(Boolean)) {
    current = join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error: any) {
      if (error?.code === 'ENOENT') break;
      throw new SealwrapperError(`Unable to inspect release directory ${current}: ${error?.message ?? error}`, 3);
    }
    if (stat.isSymbolicLink()) throw new SealwrapperError(`Refusing symbolic-link release directory component: ${relative(configuredRoot, current)}`, 3);
    let resolvedCurrent: string;
    try {
      resolvedCurrent = await realpath(current);
    } catch (error: any) {
      throw new SealwrapperError(`Unable to resolve release directory ${current}: ${error?.message ?? error}`, 3);
    }
    if (!isWithin(resolvedRoot, resolvedCurrent)) throw new SealwrapperError(`Release directory resolves outside the project root: ${relative(configuredRoot, current)}`, 3);
  }
  const stat = await lstat(directory).catch((error: any) => error?.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (stat && !stat.isDirectory()) throw new SealwrapperError(`Release directory is not a directory: ${directory}`, 3);
  return directory;
}

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

type LockBinding = { digest: string; lockVersion: number; registryVersion: number; buildTargets: string[]; defaultTarget: string };

function targetId(target: TargetDescriptor): string {
  return target.id || target.core.version;
}

function targetWithDerivedDigest(target: TargetDescriptor): LockedTarget {
  return { ...target, id: targetId(target), testOverlay: { ...target.testOverlay, digest: overlayDigest(target.testOverlay.patches) } } as LockedTarget;
}

function normalizeTargets(input: { target?: TargetDescriptor; targets?: readonly TargetDescriptor[] }): TargetDescriptor[] {
  if (input.target && input.targets) throw new SealwrapperError('Release provenance accepts either target or targets, not both', 3);
  const targets = input.targets ? [...input.targets] : input.target ? [input.target] : [];
  if (targets.length === 0) throw new SealwrapperError('Release provenance requires at least one target', 3);
  const ids = targets.map(targetId);
  if (new Set(ids).size !== ids.length) throw new SealwrapperError('Release provenance targets must be unique', 3);
  return [...targets].sort((left, right) => compareTargetIds(targetId(left), targetId(right)));
}

/** Read and bind the exact lock bytes used to produce a release. */
async function lockBinding(projectRoot: string, targets: readonly TargetDescriptor[]): Promise<LockBinding> {
  for (const target of targets) {
    try { verifyTargetTrust(target); } catch (error) { throw new SealwrapperError(`Release provenance target ${targetId(target)} trust verification failed: ${(error as Error).message}`, 3); }
  }
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
  if (!raw || !raw.targets) throw new SealwrapperError('seal.lock has no targets for release provenance', 3);
  const lock = await loadSealLock(projectRoot, toolRoot);
  for (const target of targets) {
    const id = targetId(target);
    const locked = lockedTarget(lock, id);
    const normalizedTarget = targetWithDerivedDigest(target);
    if (stable(normalizedTarget) !== stable(locked)) throw new SealwrapperError(`Release provenance target ${id} does not match the complete seal.lock descriptor`, 3);
  }
  return {
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    lockVersion: lock.lockVersion,
    registryVersion: lock.registryVersion,
    buildTargets: [...lock.buildTargets].sort(compareTargetIds),
    defaultTarget: lock.defaultTarget,
  };
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
export async function renderReleaseProvenance({ projectRoot, artifact, config, target, targets, signingKeyPath, signingKeyId }: { projectRoot: string; artifact: string; config: any; target?: TargetDescriptor; targets?: readonly TargetDescriptor[]; signingKeyPath?: string; signingKeyId?: string }): Promise<Buffer> {
  const selectedTargets = normalizeTargets({ target, targets });
  const lock = await lockBinding(projectRoot, selectedTargets);
  const archive = await readFile(artifact);
  const selectedIds = selectedTargets.map(targetId);
  const configuredDefault = config.sealDice?.defaultTarget;
  const matrixDefault = typeof configuredDefault === 'string' && selectedIds.includes(configuredDefault) ? configuredDefault : selectedIds[0];
  const primary = selectedTargets.find((item) => targetId(item) === matrixDefault) ?? selectedTargets[0];
  const targetRecords = selectedTargets.map((item) => ({
    id: targetId(item),
    core: { source: item.core.source ?? null, commit: item.core.commit, runtimeVersion: item.core.runtimeVersion, sourceDeclaredVersion: item.core.sourceDeclaredVersion ?? null, releaseArtifactSha256: item.core.releaseArtifactSha256 ?? null },
    overlay: { id: item.testOverlay.id, digest: overlayDigest(item.testOverlay.patches), protocol: item.testOverlay.protocol, capabilitiesSha256: item.testOverlay.capabilitiesSha256, patches: item.testOverlay.patches ?? [], trustKeyId: item.trust?.activeKeyId ?? null, nonProductionEquivalent: false },
  }));
  const manifest: Record<string, any> = {
    format: 'sealwrapper.release/v2',
    generatedAt: releaseTimestamp(),
    artifact: { name: basename(artifact), sha256: `sha256:${createHash('sha256').update(archive).digest('hex')}`, bytes: archive.length },
    package: { id: config.sealpack.packageId, name: config.package.name, version: config.package.version },
    targets: targetRecords,
    targetMatrix: {
      registryVersion: lock.registryVersion,
      buildTargets: selectedIds,
      defaultTarget: matrixDefault,
    },
    lock: { sha256: lock.digest, lockVersion: lock.lockVersion, registryVersion: lock.registryVersion, buildTargets: lock.buildTargets, defaultTarget: lock.defaultTarget },
  };
  if (selectedTargets.length === 1) {
    manifest.target = targetId(primary);
    manifest.core = targetRecords[0].core;
    manifest.overlay = targetRecords[0].overlay;
  }
  else {
    manifest.primaryTarget = targetId(primary);
  }
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
export async function publishReleaseFiles({ projectRoot, releaseDirectory, files }: { projectRoot: string; releaseDirectory: string; files: { source: string; name: string }[] }): Promise<string[]> {
  const directory = await assertProjectReleaseDirectory(projectRoot, releaseDirectory);
  const safe = files.map((file) => {
    if (basename(file.name) !== file.name || !file.name || file.name.includes('..')) throw new Error(`Unsafe release filename: ${file.name}`);
    return { ...file, destination: join(directory, file.name) };
  });
  if (new Set(safe.map((file) => file.name)).size !== safe.length) throw new Error('Release files contain duplicate names');
  for (const file of safe) {
    try { await access(file.destination); throw new Error(`Release artifact already exists: ${file.destination}`); }
    catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  }
  let madeDirectory = false;
  try {
    try { await access(directory); } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(directory, { recursive: true, mode: 0o755 });
      madeDirectory = true;
    }
    await assertProjectReleaseDirectory(projectRoot, directory);
    const published: string[] = [];
    try {
      for (const file of safe) {
        await assertProjectReleaseDirectory(projectRoot, directory);
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
    if (madeDirectory) await rm(directory, { force: true, recursive: false }).catch(() => {});
    throw error;
  }
}

export async function writeReleaseProvenance({ projectRoot, artifact, config, target, targets, signingKeyPath, signingKeyId }: { projectRoot: string; artifact: string; config: any; target?: TargetDescriptor; targets?: readonly TargetDescriptor[]; signingKeyPath?: string; signingKeyId?: string }) {
  const data = await renderReleaseProvenance({ projectRoot, artifact, config, target, targets, signingKeyPath, signingKeyId });
  const path = join(dirname(artifact), `${basename(artifact)}.release.json`);
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, data, { mode: 0o644 });
  // This convenience helper is for callers that already own the destination
  // directory. The CLI uses publishReleaseFiles for its all-or-nothing path.
  await link(temporary, path);
  await unlink(temporary);
  return path;
}
