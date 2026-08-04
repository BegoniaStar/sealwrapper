import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { SealwrapperError } from './errors.ts';

type WriteOptions = { mode?: number; label?: string };

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function projectRoots(projectRoot: string): Promise<{ configured: string; resolved: string }> {
  const configured = resolve(projectRoot);
  try {
    const resolved = await realpath(configured);
    const stat = await lstat(resolved);
    if (!stat.isDirectory()) throw new SealwrapperError(`Project root must be a directory: ${configured}`, 3);
    return { configured, resolved };
  } catch (error) {
    if (error instanceof SealwrapperError) throw error;
    throw new SealwrapperError(`Project root cannot be inspected: ${configured}${error instanceof Error ? ` (${error.message})` : ''}`, 3);
  }
}

/**
 * Verify a project-owned directory component by component.  A lexical path
 * check is not enough: a pre-created `.seal` or report-directory symlink can
 * otherwise redirect generated files outside the project.
 */
export async function ensureSafeProjectDirectory(projectRoot: string, directory: string, { create = true, label = 'Project output directory' }: { create?: boolean; label?: string } = {}): Promise<string> {
  const roots = await projectRoots(projectRoot);
  const target = resolve(directory);
  if (!isWithin(roots.configured, target)) throw new SealwrapperError(`${label} escapes the project root: ${directory}`, 3);
  const parts = relative(roots.configured, target).split(sep).filter(Boolean);
  let current = roots.configured;
  for (const part of parts) {
    current = join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new SealwrapperError(`Unable to inspect ${label}: ${current}`, 3);
      if (!create) throw new SealwrapperError(`${label} is missing: ${current}`, 3);
      try {
        await mkdir(current, { mode: 0o755 });
        stat = await lstat(current);
      } catch (mkdirError) {
        throw new SealwrapperError(`Unable to create ${label}: ${current}${mkdirError instanceof Error ? ` (${mkdirError.message})` : ''}`, 3);
      }
    }
    if (stat.isSymbolicLink()) throw new SealwrapperError(`Refusing symbolic-link ${label} component: ${relative(roots.configured, current)}`, 3);
    if (!stat.isDirectory()) throw new SealwrapperError(`${label} component is not a directory: ${relative(roots.configured, current)}`, 3);
    let resolved: string;
    try {
      resolved = await realpath(current);
    } catch (error) {
      throw new SealwrapperError(`Unable to resolve ${label}: ${current}${error instanceof Error ? ` (${error.message})` : ''}`, 3);
    }
    if (!isWithin(roots.resolved, resolved)) throw new SealwrapperError(`${label} resolves outside the project root: ${relative(roots.configured, current)}`, 3);
  }
  return target;
}

/** Reject absent, non-regular, and symbolic-link project files before reading. */
export async function assertSafeProjectFile(projectRoot: string, path: string, label = 'Project file'): Promise<string> {
  const roots = await projectRoots(projectRoot);
  const candidate = resolve(path);
  if (!isWithin(roots.configured, candidate)) throw new SealwrapperError(`${label} escapes the project root: ${path}`, 3);
  await ensureSafeProjectDirectory(roots.configured, dirname(candidate), { create: false, label: `${label} parent` });
  let stat;
  try {
    stat = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SealwrapperError(`${label} is missing: ${candidate}`, 3);
    throw new SealwrapperError(`Unable to inspect ${label}: ${candidate}`, 3);
  }
  if (stat.isSymbolicLink()) throw new SealwrapperError(`Refusing symbolic-link ${label}: ${relative(roots.configured, candidate)}`, 3);
  if (!stat.isFile()) throw new SealwrapperError(`${label} is not a regular file: ${relative(roots.configured, candidate)}`, 3);
  return candidate;
}

/** Validate an output path without requiring that its final file already exists. */
export async function assertSafeProjectOutputPath(projectRoot: string, path: string, label = 'Project output file'): Promise<string> {
  const roots = await projectRoots(projectRoot);
  const candidate = resolve(path);
  if (!isWithin(roots.configured, candidate)) throw new SealwrapperError(`${label} escapes the project root: ${path}`, 3);
  await ensureSafeProjectDirectory(roots.configured, dirname(candidate), { label: `${label} parent` });
  let stat;
  try {
    stat = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
    throw new SealwrapperError(`Unable to inspect ${label}: ${candidate}`, 3);
  }
  if (stat.isSymbolicLink()) throw new SealwrapperError(`Refusing symbolic-link ${label}: ${relative(roots.configured, candidate)}`, 3);
  if (!stat.isFile()) throw new SealwrapperError(`${label} is not a regular file: ${relative(roots.configured, candidate)}`, 3);
  return candidate;
}

/**
 * Atomically replace a regular project file without ever following a symlink.
 * `rename` replaces a concurrent symlink itself, never its referent.
 */
export async function writeSafeProjectFile(projectRoot: string, path: string, data: string | Buffer, options: WriteOptions = {}): Promise<string> {
  const roots = await projectRoots(projectRoot);
  const candidate = resolve(path);
  const label = options.label ?? 'Project output file';
  await assertSafeProjectOutputPath(roots.configured, candidate, label);
  const parent = dirname(candidate);
  const temporary = join(parent, `.${candidate.split(sep).at(-1)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temporary, data, { encoding: typeof data === 'string' ? 'utf8' : undefined, mode: options.mode ?? 0o644, flag: 'wx' });
    await rename(temporary, candidate);
  } catch (error) {
    throw new SealwrapperError(`Unable to write ${label}: ${candidate}${error instanceof Error ? ` (${error.message})` : ''}`, 3);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return candidate;
}

/** Create a private temporary directory beneath a verified project directory. */
export async function createSafeProjectTempDirectory(projectRoot: string, directory: string, prefix: string, label = 'Project temporary directory'): Promise<string> {
  const parent = await ensureSafeProjectDirectory(projectRoot, directory, { label: `${label} parent` });
  try {
    return await mkdtemp(join(parent, prefix));
  } catch (error) {
    throw new SealwrapperError(`Unable to create ${label}: ${parent}${error instanceof Error ? ` (${error.message})` : ''}`, 3);
  }
}
