import { deflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { invariant, SealwrapperError } from './errors.ts';
import type { BridgeCapabilities } from './capabilities.ts';

const deflate = promisify(deflateRaw);
const zipDate = 0x0021; // 1980-01-01: deterministic ZIP timestamp
const maxZipEntries = 65_535;
const maxZipSize = 0xffff_ffff;
// Keep producer-side limits aligned with the target bridge's archive gate.
// The classic ZIP field limits above are much larger and by themselves would
// permit an archive that the bridge immediately rejects (or exhaust memory
// while it is being assembled).
export const maxArchiveCompressedSize = 128 * 1024 * 1024;
export const maxArchiveExpandedSize = 512 * 1024 * 1024;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let value = 0xffff_ffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffff_ffff) >>> 0;
}

function safePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  invariant(normalized.length > 0 && !normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized) && !normalized.split('/').some((part) => !part || part === '.' || part === '..'), `Unsafe sealpack archive path: ${value}`);
  return normalized;
}

function comparePath(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function localHeader(entry: any, checksum: number): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x0403_4b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8);
  header.writeUInt16LE(0, 10); header.writeUInt16LE(zipDate, 12); header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(entry.compressed.length, 18); header.writeUInt32LE(entry.data.length, 22); header.writeUInt16LE(entry.name.length, 26);
  return header;
}

function centralHeader(entry: any, checksum: number): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x0201_4b50, 0); header.writeUInt16LE(0x0314, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(8, 10); header.writeUInt16LE(0, 12); header.writeUInt16LE(zipDate, 14); header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(entry.compressed.length, 20); header.writeUInt32LE(entry.data.length, 24); header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38); header.writeUInt32LE(entry.offset, 42);
  return header;
}

export type ZipArchiveLimits = { entries?: number; compressedSize?: number; expandedSize?: number; compressionRatio?: number };

/**
 * Select the intersection of every target's archive contract.  One release
 * artifact must be acceptable to the entire configured target matrix, so the
 * least permissive capability is the only sound producer-side limit.
 */
export function zipArchiveLimitsForCapabilities(capabilities: readonly Pick<BridgeCapabilities, 'limits'>[]): Required<ZipArchiveLimits> {
  invariant(capabilities.length > 0, 'At least one target capability is required to create a sealpack archive', 3);
  const minimum = (field: keyof BridgeCapabilities['limits']) => Math.min(...capabilities.map((item) => item.limits[field]));
  const limits = {
    entries: minimum('maxFiles'),
    compressedSize: minimum('maxArchiveBytes'),
    expandedSize: minimum('maxExpandedBytes'),
    compressionRatio: minimum('maxCompressionRatio'),
  };
  for (const [name, value] of Object.entries(limits)) invariant(Number.isSafeInteger(value) && value > 0, `Target capability ${name} must be a positive safe integer`, 3);
  return limits;
}

export async function createZipArchive(entries: { path: string; data: Buffer }[], limits: ZipArchiveLimits = {}): Promise<Buffer> {
  const entryLimit = limits.entries ?? maxZipEntries;
  const compressedLimit = limits.compressedSize ?? maxArchiveCompressedSize;
  const expandedLimit = limits.expandedSize ?? maxArchiveExpandedSize;
  const compressionRatioLimit = limits.compressionRatio ?? 100;
  invariant(Number.isSafeInteger(entryLimit) && entryLimit > 0 && entryLimit <= maxZipEntries, 'Sealpack entry limit must be a positive classic-ZIP-safe integer', 3);
  invariant(Number.isSafeInteger(compressedLimit) && compressedLimit > 0, 'Sealpack compressed limit must be a positive safe integer', 3);
  invariant(Number.isSafeInteger(expandedLimit) && expandedLimit > 0, 'Sealpack expanded limit must be a positive safe integer', 3);
  invariant(Number.isSafeInteger(compressionRatioLimit) && compressionRatioLimit > 0, 'Sealpack compression ratio limit must be a positive safe integer', 3);
  invariant(entries.length <= entryLimit, `Sealpack exceeds ${entryLimit} entry limit`, 3);
  const names = new Set<string>();
  const resolved: any[] = [];
  let offset = 0;
  let expandedSize = 0;
  let centralSize = 0;
  for (const candidate of [...entries].sort((left, right) => comparePath(left.path, right.path))) {
    const path = safePath(candidate.path);
    invariant(!names.has(path), `Duplicate sealpack entry: ${path}`, 3);
    names.add(path);
    // Staged files are already immutable snapshots.  Avoid copying a large
    // Buffer here: the aggregate limit must be enforceable without briefly
    // doubling a near-limit package's resident memory.
    const data = Buffer.isBuffer(candidate.data) ? candidate.data : Buffer.from(candidate.data);
    expandedSize += data.length;
    invariant(expandedSize <= expandedLimit, `Sealpack exceeds ${expandedLimit / (1024 * 1024)} MiB expanded limit`, 3);
    invariant(data.length <= maxZipSize, `Sealpack entry is too large: ${path}`, 3);
    const compressed = Buffer.from(await deflate(data, { level: 9 }));
    // Keep this byte-for-byte compatible with the bridge's per-entry check:
    // a highly repetitive file is otherwise an archive bomb that we create
    // locally only for the bridge to reject later.
    invariant(data.length === 0 || (compressed.length > 0 && data.length <= compressed.length * compressionRatioLimit), `Sealpack entry ${path} exceeds ${compressionRatioLimit}:1 compression ratio limit`, 3);
    const name = Buffer.from(path, 'utf8');
    const nextOffset = offset + 30 + name.length + compressed.length;
    invariant(name.length <= 0xffff && nextOffset <= maxZipSize, `Sealpack ZIP exceeds classic limits at ${path}`, 3);
    centralSize += 46 + name.length;
    invariant(nextOffset + centralSize + 22 <= compressedLimit, `Sealpack exceeds ${compressedLimit / (1024 * 1024)} MiB compressed limit`, 3);
    resolved.push({ path, name, data, compressed, offset });
    offset = nextOffset;
  }
  const locals: Buffer[] = [], central: Buffer[] = [];
  for (const entry of resolved) {
    const checksum = crc32(entry.data);
    locals.push(localHeader(entry, checksum), entry.name, entry.compressed);
    central.push(centralHeader(entry, checksum), entry.name);
  }
  const centralDirectory = Buffer.concat(central);
  invariant(offset + centralDirectory.length <= maxZipSize, 'Sealpack ZIP central directory exceeds classic limits', 3);
  invariant(offset + centralDirectory.length + 22 <= compressedLimit, `Sealpack exceeds ${compressedLimit / (1024 * 1024)} MiB compressed limit`, 3);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0); end.writeUInt16LE(resolved.length, 8); end.writeUInt16LE(resolved.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

export async function archiveSealpack(staged: { files: { path: string; data: Buffer }[] }, destination: string, limits: ZipArchiveLimits = {}): Promise<void> {
  const archive = await createZipArchive(staged.files, limits);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, archive, { mode: 0o644 });
    await rename(temporary, destination);
  } catch (error) {
    throw new SealwrapperError(`Unable to write sealpack archive: ${(error as Error).message}`, 3);
  }
}

export function zipEntryNames(archive: Buffer): string[] {
  const names: string[] = [];
  let offset = 0;
  while (offset + 4 <= archive.length && archive.readUInt32LE(offset) === 0x0403_4b50) {
    if (offset + 30 > archive.length) throw new SealwrapperError('Truncated ZIP local header', 3);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const end = offset + 30 + nameLength + extraLength + compressedSize;
    if (end > archive.length) throw new SealwrapperError('Truncated ZIP entry', 3);
    names.push(archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'));
    offset = end;
  }
  if (offset === 0 || names.length === 0) throw new SealwrapperError('ZIP has no file entries', 3);
  return names;
}
