import { spawn } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { ProjectConfig } from './config.ts';
import { SealwrapperError } from './errors.ts';

async function collect(root: string, directory: string, matcher: (name: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string) {
    const entries = await readdir(current, { withFileTypes: true }).catch((error: any) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const entry of entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
      const path = join(current, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new SealwrapperError(`Symbolic link is not allowed in JS release input: ${relative(root, path)}`, 1);
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile() && matcher(entry.name)) files.push(path);
    }
  }
  await visit(directory);
  return files;
}

function run(program: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolvePromise() : reject(new SealwrapperError(`${program} ${args.join(' ')} failed${stderr.trim() ? `:\n${stderr.trim()}` : ''}`, 1)));
  });
}

/**
 * The JS release gate deliberately has no formatter/linter dependency of its
 * own. It enforces deterministic text layout, parses every author source with
 * the locked esbuild parser (Node --check does not strip TypeScript), relies
 * on the target esbuild bundle for module and target validation, and runs the
 * project's real Node unit tests.
 */
export async function runJsReleaseQualityGate(projectRoot: string, config: Pick<ProjectConfig, 'build'>) {
  if (!config.build) return;
  const sourceFiles = await collect(projectRoot, join(projectRoot, 'src'), (name) => /\.(?:[cm]?js|tsx?)$/.test(name));
  if (sourceFiles.length === 0) throw new SealwrapperError('JS release gate requires at least one source file under src/', 1);
  let esbuild: typeof import('esbuild');
  try { esbuild = await import('esbuild'); } catch { throw new SealwrapperError('JS release gate requires the locked esbuild dependency; run npm ci', 3); }
  for (const file of sourceFiles) {
    const content = await readFile(file, 'utf8');
    if (content.includes('\r\n') || !content.endsWith('\n')) throw new SealwrapperError(`Formatting gate failed for ${relative(projectRoot, file)}: use LF line endings and a final newline`, 1);
    const loader = file.endsWith('.tsx') ? 'tsx' : /\.[cm]?ts$/.test(file) ? 'ts' : 'js';
    try { await esbuild.transform(content, { loader, sourcefile: relative(projectRoot, file), target: config.build.ecmaTarget }); }
    catch (error: any) { throw new SealwrapperError(`Source syntax gate failed for ${relative(projectRoot, file)}: ${error.message}`, 1); }
  }
  const tests = await collect(projectRoot, join(projectRoot, 'tests', 'unit'), (name) => /\.test\.(?:[cm]?js|tsx?)$/.test(name));
  if (tests.length === 0) throw new SealwrapperError('JS release gate requires at least one tests/unit/*.test.{ts,js} file', 1);
  await run(process.execPath, ['--experimental-strip-types', '--test', ...tests], projectRoot);
}
