import { readFile } from 'node:fs/promises';
import { isAbsolute, posix } from 'node:path';

import { invariant, SealwrapperError } from './errors.ts';
import { compareTargetIds, minimumTargetId, targetRegistry, type TargetDescriptor } from './pinned-target.ts';

const packageIdPattern = /^[\p{L}\p{N}_-]{1,64}\/[\p{L}\p{N}_-]{1,64}$/u;
// SemVer 2.0.0's grammar is almost expressible as one regexp.  The one
// rule that needs a small follow-up check is that numeric prerelease
// identifiers may not contain leading zeroes (for example, `-01` is not
// valid, while `-0` is).
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, any> {
  invariant(isRecord(value), `${label} must be an object`);
  return value;
}

function array(value: unknown, label: string): any[] {
  invariant(Array.isArray(value), `${label} must be an array`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  const values = array(value, label);
  return values.map((item, index) => string(item, `${label}[${index}]`));
}

function string(value: unknown, label: string, allowEmpty = false): string {
  invariant(typeof value === 'string' && (allowEmpty || value.length > 0), `${label} must be a ${allowEmpty ? 'string' : 'non-empty string'}`);
  invariant(!controlCharacterPattern.test(value), `${label} must not contain control characters`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  invariant(typeof value === 'boolean', `${label} must be a boolean`);
  return value;
}

/** Keep the v2 manifest closed so every accepted field has one owner. */
function onlyKeys(value: Record<string, any>, label: string, allowed: readonly string[]) {
  for (const key of Object.keys(value)) invariant(allowed.includes(key), `${label}.${key} is unsupported`);
}

export function safeProjectPath(value: unknown, label: string, prefix?: string): string {
  const path = string(value, label);
  invariant(!isAbsolute(path) && !path.includes('\\') && !/^[A-Za-z]:/.test(path), `${label} must be a slash-separated project-relative path`);
  const segments = path.split('/');
  invariant(!segments.some((part) => !part || part === '.' || part === '..'), `${label} must not contain empty, . or .. path segments`);
  if (prefix) invariant(path === prefix || path.startsWith(`${prefix}/`), `${label} must stay under ${prefix}/`);
  return path;
}

function verifyMetadata(config: Record<string, any>) {
  const metadata = record(config.package, 'package');
  onlyKeys(metadata, 'package', ['name', 'version', 'authors', 'license', 'description', 'homepage']);
  string(metadata.name, 'package.name');
  const version = string(metadata.version, 'package.version');
  const semver = semverPattern.exec(version);
  invariant(semver && !(semver[4]?.split('.').some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))), 'package.version must be canonical semantic version');
  const authors = array(metadata.authors, 'package.authors');
  invariant(authors.length > 0 && authors.every((author) => typeof author === 'string' && author.length > 0), 'package.authors must contain at least one non-empty string');
  for (const [index, author] of authors.entries()) string(author, `package.authors[${index}]`);
  string(metadata.license, 'package.license');
  string(metadata.description, 'package.description', true);
  string(metadata.homepage, 'package.homepage', true);
}

export type TargetSelection = { buildTarget: string[]; defaultTarget: string };

function verifyBuildTargets(config: Record<string, any>, registry: Readonly<Record<string, TargetDescriptor>>): TargetSelection {
  const sealDice = record(config.sealDice, 'sealDice');
  onlyKeys(sealDice, 'sealDice', ['buildTarget', 'defaultTarget']);
  const buildTarget = strings(sealDice.buildTarget, 'sealDice.buildTarget');
  invariant(buildTarget.length > 0, 'sealDice.buildTarget must contain at least one target');
  invariant(new Set(buildTarget).size === buildTarget.length, 'sealDice.buildTarget must not contain duplicate targets');
  for (const [index, id] of buildTarget.entries()) {
    invariant(registry[id] !== undefined, `sealDice.buildTarget[${index}] is not included in this sealwrapper target registry: ${id}`);
    invariant(registry[id].id === id, `sealDice.buildTarget[${index}] registry descriptor does not identify target ${id}`);
  }
  const defaultTarget = string(sealDice.defaultTarget, 'sealDice.defaultTarget');
  invariant(buildTarget.includes(defaultTarget), 'sealDice.defaultTarget must be included in sealDice.buildTarget');
  return { buildTarget, defaultTarget };
}

function verifyBuild(config: Record<string, any>, contents: Record<string, any>) {
  const scripts = contents.scripts;
  if (scripts === undefined) {
    invariant(config.build === undefined, 'build requires sealpack.contents.scripts');
    return;
  }
  const spec = record(scripts, 'sealpack.contents.scripts');
  onlyKeys(spec, 'sealpack.contents.scripts', ['bundle', 'path']);
  invariant(spec.bundle === true, 'sealpack.contents.scripts.bundle must be true');
  const bundlePath = safeProjectPath(spec.path, 'sealpack.contents.scripts.path', 'scripts');
  invariant(bundlePath.endsWith('.js') && !bundlePath.includes('*'), 'sealpack.contents.scripts.path must name one .js file');
  const build = record(config.build, 'build');
  onlyKeys(build, 'build', ['entry', 'ecmaTarget', 'bundleFileName']);
  const entry = safeProjectPath(build.entry, 'build.entry', 'src');
  invariant(/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry), 'build.entry must be a JS or TS source file');
  string(build.bundleFileName, 'build.bundleFileName');
  invariant(posix.basename(build.bundleFileName) === build.bundleFileName && build.bundleFileName === bundlePath.slice('scripts/'.length), 'build.bundleFileName must equal the scripts/ bundle file name');
  string(build.ecmaTarget, 'build.ecmaTarget');
}

function verifySealpack(config: Record<string, any>, selection: TargetSelection) {
  const sealpack = record(config.sealpack, 'sealpack');
  onlyKeys(sealpack, 'sealpack', ['packageId', 'minSealDice', 'contents', 'dependencies', 'permissions', 'readme', 'assets', 'store']);
  const packageId = string(sealpack.packageId, 'sealpack.packageId');
  invariant(packageIdPattern.test(packageId), 'sealpack.packageId must use author/package form');
  const min = string(sealpack.minSealDice, 'sealpack.minSealDice');
  invariant(min === minimumTargetId(selection.buildTarget), `sealpack.minSealDice must equal the lowest selected target (${minimumTargetId(selection.buildTarget)})`);
  const contents = record(sealpack.contents, 'sealpack.contents');
  for (const key of Object.keys(contents)) invariant(['scripts', 'decks', 'reply', 'helpdoc', 'templates'].includes(key), `sealpack.contents.${key} is unsupported`);
  invariant(Object.keys(contents).length > 0, 'sealpack.contents must declare at least one supported content type');
  for (const key of ['decks', 'reply', 'helpdoc', 'templates']) {
    if (contents[key] === undefined) continue;
    const spec = record(contents[key], `sealpack.contents.${key}`);
    onlyKeys(spec, `sealpack.contents.${key}`, ['source']);
    const source = safeProjectPath(spec.source, `sealpack.contents.${key}.source`, 'content');
    invariant(source === `content/${key}`, `sealpack.contents.${key}.source must be content/${key}`);
  }
  verifyBuild(config, contents);

  const permissions = record(sealpack.permissions, 'sealpack.permissions');
  onlyKeys(permissions, 'sealpack.permissions', ['network', 'networkHosts', 'acknowledgeUnrestrictedNetwork', 'fileRead', 'fileWrite', 'dangerous', 'httpServer', 'ipc']);
  for (const name of ['network', 'acknowledgeUnrestrictedNetwork', 'dangerous', 'httpServer']) boolean(permissions[name], `sealpack.permissions.${name}`);
  for (const name of ['networkHosts', 'fileRead', 'fileWrite', 'ipc']) strings(permissions[name], `sealpack.permissions.${name}`);
  if (!permissions.network) {
    invariant(permissions.networkHosts.length === 0 && !permissions.acknowledgeUnrestrictedNetwork, 'networkHosts and acknowledgeUnrestrictedNetwork require network: true');
  }
  if (permissions.network && permissions.networkHosts.length === 0) invariant(permissions.acknowledgeUnrestrictedNetwork, 'unrestricted network requires acknowledgeUnrestrictedNetwork: true');

  invariant(sealpack.readme === 'README.md', 'sealpack.readme must be README.md');
  for (const asset of array(sealpack.assets, 'sealpack.assets')) safeProjectPath(asset, 'sealpack.assets entry', 'assets');
  const store = record(sealpack.store, 'sealpack.store');
  onlyKeys(store, 'sealpack.store', ['category', 'icon', 'banner', 'screenshots']);
  string(store.category, 'sealpack.store.category', true);
  for (const name of ['icon', 'banner']) {
    // An empty string is the manifest's explicit "not supplied" sentinel.
    // Do not use truthiness here: `false`, `0`, and `null` must not silently
    // turn into an absent asset.
    if (store[name] === undefined) {
      store[name] = '';
      continue;
    }
    const asset = string(store[name], `sealpack.store.${name}`, true);
    if (asset.length > 0) safeProjectPath(asset, `sealpack.store.${name}`, 'assets');
  }
  for (const asset of array(store.screenshots, 'sealpack.store.screenshots')) safeProjectPath(asset, 'sealpack.store.screenshots entry', 'assets');
  const dependencies = record(sealpack.dependencies, 'sealpack.dependencies');
  for (const [id, range] of Object.entries(dependencies)) {
    invariant(packageIdPattern.test(id), 'sealpack.dependencies must use package IDs and non-empty ranges');
    string(range, `sealpack.dependencies.${id}`);
  }
}

function verifyRelease(config: Record<string, any>) {
  const release = record(config.release, 'release');
  onlyKeys(release, 'release', ['directory', 'checksum', 'artifactPolicy']);
  safeProjectPath(release.directory, 'release.directory');
  invariant(release.checksum === 'sha256', 'release.checksum must be sha256');
  const policy = record(release.artifactPolicy, 'release.artifactPolicy');
  onlyKeys(policy, 'release.artifactPolicy', ['forbiddenPaths', 'forbiddenExtensions']);
  for (const name of ['forbiddenPaths', 'forbiddenExtensions']) strings(policy[name], `release.artifactPolicy.${name}`);
}

export function validateProjectConfig(raw: unknown, registry: Readonly<Record<string, TargetDescriptor>> = targetRegistry): any {
  const config = record(raw, 'seal.config.json');
  onlyKeys(config, 'seal.config.json', ['$schema', 'schemaVersion', 'package', 'build', 'sealDice', 'release', 'sealpack']);
  if (config.$schema !== undefined) string(config.$schema, 'seal.config.json.$schema');
  invariant(config.schemaVersion === 2, 'Only schemaVersion: 2 is supported');
  verifyMetadata(config);
  const selection = verifyBuildTargets(config, registry);
  verifyRelease(config);
  verifySealpack(config, selection);
  return config;
}

/** Return the target IDs selected by the project build matrix. */
export function configuredTargetIds(config: Record<string, any>): string[] {
  return sortTargetIds(config.sealDice.buildTarget);
}

/** Return the target used when a command needs one default target. */
export function configuredDefaultTarget(config: Record<string, any>): string {
  return config.sealDice.defaultTarget;
}

/** Keep target selections deterministic when rendering matrices and reports. */
export function sortTargetIds(ids: readonly string[]): string[] {
  return [...ids].sort(compareTargetIds);
}

export async function loadProjectConfig(root: string): Promise<any> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(`${root}/seal.config.json`, 'utf8'));
  } catch (error: any) {
    if (error instanceof SyntaxError) throw new SealwrapperError(`seal.config.json is not valid JSON: ${error.message}`);
    throw error;
  }
  return validateProjectConfig(raw);
}
