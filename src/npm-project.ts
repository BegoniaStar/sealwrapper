import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJson } from './capabilities.ts';
import { isCanonicalSemanticVersion, type ProjectConfig } from './config.ts';
import { invariant, SealwrapperError } from './errors.ts';

type JsonRecord = Record<string, unknown>;

export type NpmProject = {
  manifest: JsonRecord;
  lockfile: JsonRecord;
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  invariant(isRecord(value), `${label} must be an object`);
  return value;
}

function text(value: unknown, label: string): string {
  invariant(typeof value === 'string' && value.length > 0, `${label} must be a non-empty string`);
  return value;
}

async function readJson(path: string, label: string): Promise<JsonRecord> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error: any) {
    if (error instanceof SyntaxError) throw new SealwrapperError(`${label} is not valid JSON: ${error.message}`);
    throw error;
  }
  return record(raw, label);
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function dependencyMap(value: unknown, label: string): JsonRecord {
  if (value === undefined) return {};
  const dependencies = record(value, label);
  for (const [name, spec] of Object.entries(dependencies)) {
    invariant(name.length > 0 && typeof spec === 'string' && spec.length > 0, `${label} must map non-empty package names to non-empty string specs`);
  }
  return dependencies;
}

function peerDependencyMeta(value: unknown, label: string): JsonRecord {
  if (value === undefined) return {};
  const metadata = record(value, label);
  for (const [name, details] of Object.entries(metadata)) {
    invariant(name.length > 0 && isRecord(details), `${label} must map non-empty package names to objects`);
  }
  return metadata;
}

function compareDirectDependencies(manifest: JsonRecord, lockRoot: JsonRecord) {
  for (const name of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const expected = dependencyMap(manifest[name], `package.json.${name}`);
    const actual = dependencyMap(lockRoot[name], `package-lock.json.packages[\"\"].${name}`);
    invariant(canonicalJson(actual) === canonicalJson(expected), `package-lock.json is stale: packages[\"\"].${name} must match package.json.${name}; run npm install`);
  }
  const expectedPeerMetadata = peerDependencyMeta(manifest.peerDependenciesMeta, 'package.json.peerDependenciesMeta');
  const actualPeerMetadata = peerDependencyMeta(lockRoot.peerDependenciesMeta, 'package-lock.json.packages[\"\"].peerDependenciesMeta');
  invariant(canonicalJson(actualPeerMetadata) === canonicalJson(expectedPeerMetadata), 'package-lock.json is stale: packages[\"\"].peerDependenciesMeta must match package.json.peerDependenciesMeta; run npm install');
}

/**
 * Validate the optional npm development project without making it part of the
 * sealpack. The lockfile must describe the exact root manifest, but verifying
 * the installed dependency tree remains npm ci's responsibility.
 */
export async function validateNpmProject(root: string): Promise<NpmProject | undefined> {
  const manifestPath = join(root, 'package.json');
  const lockfilePath = join(root, 'package-lock.json');
  const hasManifest = await exists(manifestPath);
  const hasLockfile = await exists(lockfilePath);
  if (!hasManifest) {
    invariant(!hasLockfile, 'package-lock.json requires package.json');
    return undefined;
  }
  invariant(hasLockfile, 'package.json requires a committed package-lock.json');

  const manifest = await readJson(manifestPath, 'package.json');
  const lockfile = await readJson(lockfilePath, 'package-lock.json');
  const name = text(manifest.name, 'package.json.name');
  const version = text(manifest.version, 'package.json.version');
  invariant(isCanonicalSemanticVersion(version), 'package.json.version must be canonical semantic version');
  if (manifest.packageManager !== undefined) {
    const packageManager = text(manifest.packageManager, 'package.json.packageManager');
    invariant(packageManager.startsWith('npm@') && isCanonicalSemanticVersion(packageManager.slice('npm@'.length)), 'package.json.packageManager must be a canonical npm@<semver> value when package-lock.json is used');
  }

  invariant(lockfile.lockfileVersion === 3, 'package-lock.json must use lockfileVersion: 3');
  invariant(lockfile.name === name, 'package-lock.json.name must match package.json.name');
  invariant(lockfile.version === version, 'package-lock.json.version must match package.json.version');
  const packages = record(lockfile.packages, 'package-lock.json.packages');
  const lockRoot = record(packages[''], 'package-lock.json.packages[\"\"]');
  invariant(lockRoot.name === name, 'package-lock.json.packages[\"\"].name must match package.json.name');
  invariant(lockRoot.version === version, 'package-lock.json.packages[\"\"].version must match package.json.version');
  compareDirectDependencies(manifest, lockRoot);
  return { manifest, lockfile };
}

function personName(value: unknown, label: string): string {
  if (typeof value === 'string') return text(value, label);
  const person = record(value, label);
  return text(person.name, `${label}.name`);
}

function npmAuthors(manifest: JsonRecord): string[] {
  const authors: string[] = [];
  if (manifest.author !== undefined) authors.push(personName(manifest.author, 'package.json.author'));
  if (manifest.contributors !== undefined) {
    invariant(Array.isArray(manifest.contributors), 'package.json.contributors must be an array');
    for (const [index, contributor] of manifest.contributors.entries()) authors.push(personName(contributor, `package.json.contributors[${index}]`));
  }
  return authors;
}

/**
 * A private npm project and its sealpack deliberately use different names,
 * but all duplicated release metadata must agree before publication.
 */
export function assertNpmReleaseMetadata(project: NpmProject | undefined, config: Pick<ProjectConfig, 'package'>) {
  if (!project) return;
  const metadata = config.package;
  const actual = {
    version: project.manifest.version,
    authors: npmAuthors(project.manifest),
    description: project.manifest.description,
    homepage: project.manifest.homepage,
    license: project.manifest.license,
  };
  const expected = {
    version: metadata.version,
    authors: metadata.authors,
    description: metadata.description,
    homepage: metadata.homepage,
    license: metadata.license,
  };
  const differences = Object.keys(expected).filter((field) => canonicalJson(actual[field as keyof typeof actual]) !== canonicalJson(expected[field as keyof typeof expected]));
  invariant(differences.length === 0, `package.json release metadata must match seal.config.json.package: ${differences.join(', ')}. Use package.json.author plus package.json.contributors for the ordered author list.`);
}
