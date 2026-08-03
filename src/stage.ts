import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, posix, relative, resolve } from 'node:path';

import { buildBundle } from './build.ts';
import { configuredTargetIds } from './config.ts';
import { invariant, SealwrapperError } from './errors.ts';

export type StagedFile = { path: string; data: Buffer };
export type StagedSealpack = { files: StagedFile[]; manifest: string; packageId: string; version: string };

function compareArchivePath(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function archivePath(value: string, label: string): string {
  const normalized = value.replaceAll('\\', '/');
  invariant(normalized.length > 0 && !normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized) && !normalized.split('/').some((part) => !part || part === '.' || part === '..'), `${label} is not a safe archive-relative path`);
  return normalized;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function collectRegularFiles(root: string, source: string, archiveRoot: string, into: Map<string, Buffer>, required: boolean) {
  const rootAbsolute = resolve(root);
  const sourceRelative = relative(rootAbsolute, source);
  let ancestor = rootAbsolute;
  for (const segment of sourceRelative.split(/[\\/]/).filter(Boolean)) {
    ancestor = join(ancestor, segment);
    const ancestorStat = await lstat(ancestor).catch(() => null);
    if (ancestorStat?.isSymbolicLink()) throw new SealwrapperError(`Symbolic link is not allowed: ${relative(rootAbsolute, ancestor)}`);
  }
  if (!(await exists(source))) {
    if (required) throw new SealwrapperError(`Declared resource source does not exist: ${relative(root, source)}`);
    return;
  }
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) throw new SealwrapperError(`Symbolic link is not allowed: ${relative(root, source)}`);
  if (!stat.isDirectory()) throw new SealwrapperError(`Resource source must be a directory: ${relative(root, source)}`);
  async function visit(current: string) {
    const children = await readdir(current, { withFileTypes: true });
    children.sort((left, right) => compareArchivePath(left.name, right.name));
    for (const child of children) {
      const childPath = join(current, child.name);
      const local = relative(source, childPath).replaceAll('\\', '/');
      const target = archivePath(posix.join(archiveRoot, local), 'staged file');
      if (child.isSymbolicLink()) throw new SealwrapperError(`Symbolic link is not allowed: ${relative(root, childPath)}`);
      if (child.isDirectory()) await visit(childPath);
      else if (child.isFile()) {
        if (into.has(target)) throw new SealwrapperError(`Duplicate staged archive path: ${target}`);
        into.set(target, await readFile(childPath));
      } else throw new SealwrapperError(`Only regular files are allowed: ${relative(root, childPath)}`);
    }
  }
  await visit(source);
}

function manifestFor(config: any, staged: Map<string, Buffer>): string {
  const contents = config.sealpack.contents;
  const patterns = (name: string) => {
    if (!(name in contents)) return [];
    // A JS bundle is a single generated file with an author-declared archive
    // path. Keep its manifest entry exact so the package cannot accidentally
    // opt into future files below scripts/. Resource roots deliberately use a
    // target-core glob because they are recursively discovered collections.
    if (name === 'scripts') return staged.has(contents.scripts.path) ? [contents.scripts.path] : [];
    return [...staged.keys()].some((file) => file.startsWith(`${name}/`)) ? [`${name}/**`] : [];
  };
  const permission = config.sealpack.permissions;
  const lines = [
    'format_version = "1.0.0"', '', '[package]',
    `id = ${tomlString(config.sealpack.packageId)}`,
    `name = ${tomlString(config.package.name)}`,
    `version = ${tomlString(config.package.version)}`,
    `authors = ${tomlArray(config.package.authors)}`,
    `license = ${tomlString(config.package.license)}`,
    `description = ${tomlString(config.package.description)}`,
    `homepage = ${tomlString(config.package.homepage)}`,
    '', '[package.seal]', `min_version = ${tomlString(config.sealpack.minSealDice)}`,
    '', '[dependencies]',
  ];
  for (const [id, range] of Object.entries(config.sealpack.dependencies).sort(([a], [b]) => compareArchivePath(a, b))) lines.push(`${tomlString(id)} = ${tomlString(range as string)}`);
  lines.push('', '[permissions]', `network = ${permission.network}`, `network_hosts = ${tomlArray(permission.networkHosts)}`, `file_read = ${tomlArray(permission.fileRead)}`, `file_write = ${tomlArray(permission.fileWrite)}`, `dangerous = ${permission.dangerous}`, `http_server = ${permission.httpServer}`, `ipc = ${tomlArray(permission.ipc)}`, '', '[contents]');
  for (const name of ['scripts', 'decks', 'reply', 'helpdoc', 'templates']) lines.push(`${name} = ${tomlArray(patterns(name))}`);
  const store = config.sealpack.store;
  lines.push('', '[store]', `readme = ${tomlString(config.sealpack.readme)}`, `icon = ${tomlString(store.icon)}`, `banner = ${tomlString(store.banner)}`, `screenshots = ${tomlArray(store.screenshots)}`, `category = ${tomlString(store.category)}`, '', '[config]', '');
  return lines.join('\n');
}

export async function stageSealpack({ root, config, target }: { root: string; config: any; target?: string }): Promise<StagedSealpack> {
  if (target !== undefined) invariant(configuredTargetIds(config).includes(target), `Target ${target} is not selected by sealDice.buildTarget`);
  if (await exists(join(root, 'package.json')) && !(await exists(join(root, 'package-lock.json')))) throw new SealwrapperError('package.json requires a committed package-lock.json');
  const files = new Map<string, Buffer>();
  const readme = resolve(root, config.sealpack.readme);
  if (!readme.startsWith(`${resolve(root)}/`)) throw new SealwrapperError('sealpack.readme escapes project root');
  const readmeStat = await lstat(readme).catch(() => null);
  if (!readmeStat?.isFile() || readmeStat.isSymbolicLink()) throw new SealwrapperError('README.md must be a regular file');
  files.set('README.md', await readFile(readme));

  const contents = config.sealpack.contents;
  if (contents.scripts) files.set(contents.scripts.path, await buildBundle(root, config));
  for (const kind of ['decks', 'reply', 'helpdoc', 'templates']) {
    if (!contents[kind]) continue;
    const before = files.size;
    await collectRegularFiles(root, join(root, 'content', kind), kind, files, true);
    invariant(files.size > before, `Declared ${kind} source contains no regular files`);
  }
  await collectRegularFiles(root, join(root, 'assets'), 'assets', files, false);
  for (const asset of config.sealpack.assets) invariant(files.has(asset), `Declared sealpack asset is not staged: ${asset}`);
  for (const asset of [config.sealpack.store.icon, config.sealpack.store.banner, ...config.sealpack.store.screenshots].filter(Boolean)) invariant(files.has(asset), `Declared store asset is not staged: ${asset}`);

  const manifest = manifestFor(config, files);
  files.set('info.toml', Buffer.from(manifest, 'utf8'));
  return {
    files: [...files.entries()].map(([path, data]) => ({ path, data })).sort((left, right) => compareArchivePath(left.path, right.path)),
    manifest,
    packageId: config.sealpack.packageId,
    version: config.package.version,
  };
}
