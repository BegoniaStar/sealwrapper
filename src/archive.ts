import { deflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { invariant, SealwrapperError } from './errors.ts';

const deflate = promisify(deflateRaw);
const zipDate = 0x0021; // 1980-01-01: deterministic ZIP timestamp
const maxZipEntries = 65_535;
const maxZipSize = 0xffff_ffff;

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

export async function createZipArchive(entries: { path: string; data: Buffer }[]): Promise<Buffer> {
  invariant(entries.length <= maxZipEntries, 'Sealpack exceeds classic ZIP entry limit', 3);
  const names = new Set<string>();
  const resolved: any[] = [];
  let offset = 0;
  for (const candidate of [...entries].sort((left, right) => comparePath(left.path, right.path))) {
    const path = safePath(candidate.path);
    invariant(!names.has(path), `Duplicate sealpack entry: ${path}`, 3);
    names.add(path);
    const data = Buffer.from(candidate.data);
    invariant(data.length <= maxZipSize, `Sealpack entry is too large: ${path}`, 3);
    const compressed = Buffer.from(await deflate(data, { level: 9 }));
    const name = Buffer.from(path, 'utf8');
    invariant(name.length <= 0xffff && offset + 30 + name.length + compressed.length <= maxZipSize, `Sealpack ZIP exceeds classic limits at ${path}`, 3);
    resolved.push({ path, name, data, compressed, offset });
    offset += 30 + name.length + compressed.length;
  }
  const locals: Buffer[] = [], central: Buffer[] = [];
  for (const entry of resolved) {
    const checksum = crc32(entry.data);
    locals.push(localHeader(entry, checksum), entry.name, entry.compressed);
    central.push(centralHeader(entry, checksum), entry.name);
  }
  const centralDirectory = Buffer.concat(central);
  invariant(offset + centralDirectory.length <= maxZipSize, 'Sealpack ZIP central directory exceeds classic limits', 3);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0); end.writeUInt16LE(resolved.length, 8); end.writeUInt16LE(resolved.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

export async function archiveSealpack(staged: { files: { path: string; data: Buffer }[] }, destination: string): Promise<void> {
  const archive = await createZipArchive(staged.files);
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
