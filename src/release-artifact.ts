import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { SealwrapperError } from './errors.ts';

const maximumReleaseArtifactBytes = 1024 * 1024 * 1024;

export type CoreReleaseArtifact = {
  version: string;
  releaseArtifactSha256: string;
  release: { repository: string; tag: string };
};

export type VerifiedReleaseArtifact = { path: string; sha256: string; bytes: number; source: 'cache' | 'download' };

function expectedSha256(core: CoreReleaseArtifact): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(core.releaseArtifactSha256)) throw new SealwrapperError('Target release artifact SHA-256 is malformed', 3);
  return core.releaseArtifactSha256;
}

/**
 * The signed target descriptor pins the Linux amd64 release digest.  The
 * filename is a deterministic upstream release convention; authentication is
 * supplied by the descriptor hash, never by a redirect or release-page text.
 */
export function sourceCoreReleaseArtifactUrl(core: CoreReleaseArtifact): string {
  let repository: URL;
  try { repository = new URL(core.release.repository); } catch { throw new SealwrapperError('Target release repository URL is malformed', 3); }
  const parts = repository.pathname.split('/').filter(Boolean);
  if (repository.protocol !== 'https:' || repository.hostname !== 'github.com' || parts.length !== 2) throw new SealwrapperError('Target release artifact repository must be a GitHub HTTPS repository', 3);
  if (!/^v?[0-9A-Za-z._+-]+$/u.test(core.release.tag) || !/^[0-9A-Za-z._+-]+$/u.test(core.version)) throw new SealwrapperError('Target release artifact version metadata is malformed', 3);
  const fileName = `sealdice-core_${core.version}_linux_amd64.tar.gz`;
  return `https://github.com/${parts.map(encodeURIComponent).join('/')}/releases/download/${encodeURIComponent(core.release.tag)}/${encodeURIComponent(fileName)}`;
}

export function sourceCoreReleaseArtifactPath(directory: string, core: CoreReleaseArtifact): string {
  return join(directory, `sealdice-core_${core.version}_linux_amd64.tar.gz`);
}

async function hashRegularFile(path: string): Promise<{ sha256: string; bytes: number }> {
  let stat;
  try { stat = await lstat(path); } catch (error: any) {
    if (error?.code === 'ENOENT') throw new SealwrapperError(`Release artifact is missing: ${path}`, 3);
    throw new SealwrapperError(`Unable to inspect release artifact: ${error?.message ?? error}`, 3);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new SealwrapperError(`Release artifact must be a regular non-symbolic-link file: ${path}`, 3);
  if (stat.size > maximumReleaseArtifactBytes) throw new SealwrapperError(`Release artifact exceeds ${maximumReleaseArtifactBytes} byte limit`, 3);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      bytes += chunk.length;
      if (bytes > maximumReleaseArtifactBytes) throw new SealwrapperError(`Release artifact exceeds ${maximumReleaseArtifactBytes} byte limit`, 3);
      hash.update(chunk);
    }
  } catch (error) {
    if (error instanceof SealwrapperError) throw error;
    throw new SealwrapperError(`Unable to read release artifact: ${error instanceof Error ? error.message : String(error)}`, 3);
  }
  return { sha256: `sha256:${hash.digest('hex')}`, bytes };
}

/** Verify the exact bytes used as the target's upstream release evidence. */
export async function verifyReleaseArtifact(path: string, core: CoreReleaseArtifact): Promise<{ sha256: string; bytes: number }> {
  const result = await hashRegularFile(path);
  if (result.sha256 !== expectedSha256(core)) throw new SealwrapperError(`Release artifact SHA-256 mismatch: expected ${expectedSha256(core)}, found ${result.sha256}`, 3);
  return result;
}

async function downloadReleaseArtifact(url: string, destination: string, expected: string, fetchImpl: typeof fetch): Promise<{ sha256: string; bytes: number }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/octet-stream' }, redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    throw new SealwrapperError(`Unable to download target release artifact: ${error instanceof Error ? error.message : String(error)}`, 3);
  }
  if (!response.ok || !response.body) throw new SealwrapperError(`Target release artifact download failed: HTTP ${response.status}`, 3);
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > maximumReleaseArtifactBytes) throw new SealwrapperError(`Target release artifact exceeds ${maximumReleaseArtifactBytes} byte limit`, 3);
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  const hash = createHash('sha256');
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > maximumReleaseArtifactBytes) {
        callback(new SealwrapperError(`Target release artifact exceeds ${maximumReleaseArtifactBytes} byte limit`, 3));
        return;
      }
      hash.update(data);
      callback(null, data);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]), limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    const sha256 = `sha256:${hash.digest('hex')}`;
    if (sha256 !== expected) throw new SealwrapperError(`Downloaded release artifact SHA-256 mismatch: expected ${expected}, found ${sha256}`, 3);
    await rename(temporary, destination);
    return { sha256, bytes };
  } catch (error) {
    if (error instanceof SealwrapperError) throw error;
    throw new SealwrapperError(`Unable to save target release artifact: ${error instanceof Error ? error.message : String(error)}`, 3);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Cache a verified upstream artifact beneath the managed core directory. An
 * existing file is never trusted merely because it has the expected name.
 */
export async function syncReleaseArtifact({ directory, core, offline = false, fetchImpl = fetch }: { directory: string; core: CoreReleaseArtifact; offline?: boolean; fetchImpl?: typeof fetch }): Promise<VerifiedReleaseArtifact> {
  const path = sourceCoreReleaseArtifactPath(directory, core);
  try {
    const cached = await verifyReleaseArtifact(path, core);
    return { path, ...cached, source: 'cache' };
  } catch (error) {
    if (offline) throw new SealwrapperError(`core sync --offline cannot use the pinned release artifact: ${(error as Error).message}`, 3);
  }
  const downloaded = await downloadReleaseArtifact(sourceCoreReleaseArtifactUrl(core), path, expectedSha256(core), fetchImpl);
  return { path, ...downloaded, source: 'download' };
}
