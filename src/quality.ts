import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { ProjectConfig } from './config.ts';
import { SealwrapperError } from './errors.ts';
import { assertGojaEcmaTarget, scanGojaCompatibility } from './goja-compatibility.ts';
import { runProcess } from './process.ts';

const defaultQualityTestTimeoutMilliseconds = 300_000;
const defaultQualityTestOutputBytes = 8 * 1024 * 1024;

async function collect(root: string, directory: string, matcher: (name: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string) {
    const entries = await readdir(current, { withFileTypes: true }).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      return Promise.reject(error);
    });
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

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

async function runTests(program: string, args: string[], cwd: string, timeoutMs: number, maxOutputBytes: number): Promise<void> {
  let result;
  try {
    // Node marks its own test-worker processes with NODE_TEST_CONTEXT. Do not
    // leak that implementation detail into an author test runner we launch.
    result = await runProcess(program, args, { cwd, env: { NODE_TEST_CONTEXT: undefined }, timeoutMs, maxOutputBytes });
  } catch (error) {
    throw new SealwrapperError(`${program} ${args.join(' ')} could not start: ${error instanceof Error ? error.message : String(error)}`, 3);
  }
  if (result.timedOut) throw new SealwrapperError(`JS release tests timed out after ${timeoutMs}ms`, 1);
  if (result.outputExceeded) throw new SealwrapperError(`JS release tests exceeded the ${maxOutputBytes} byte output limit`, 1);
  if (result.code !== 0) {
    const detail = `${result.stdout}\n${result.stderr}`.trim();
    throw new SealwrapperError(`${program} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`, 1);
  }
}

export type QualityGateOptions = {
  testTimeoutMs?: number;
  maxTestOutputBytes?: number;
};

/**
 * The JS release gate deliberately has no formatter/linter dependency of its
 * own. It enforces deterministic text layout, parses every author source with
 * the locked esbuild parser (Node --check does not strip TypeScript), relies
 * on the target esbuild bundle for module and target validation, runs the
 * Goja compatibility profile, and runs the project's real Node unit tests.
 */
export async function runJsReleaseQualityGate(projectRoot: string, config: Pick<ProjectConfig, 'build'>, options: QualityGateOptions = {}) {
  if (!config.build) return;
  assertGojaEcmaTarget(config.build.ecmaTarget);
  const testTimeoutMs = positiveSafeInteger(options.testTimeoutMs ?? defaultQualityTestTimeoutMilliseconds, 'Quality test timeout');
  const maxTestOutputBytes = positiveSafeInteger(options.maxTestOutputBytes ?? defaultQualityTestOutputBytes, 'Quality test output limit');
  const sourceFiles = await collect(projectRoot, join(projectRoot, 'src'), (name) => /\.(?:[cm]?js|tsx?)$/.test(name));
  if (sourceFiles.length === 0) throw new SealwrapperError('JS release gate requires at least one source file under src/', 1);
  let esbuild: typeof import('esbuild');
  try { esbuild = await import('esbuild'); } catch { throw new SealwrapperError('JS release gate requires the locked esbuild dependency; run npm ci', 3); }
  for (const file of sourceFiles) {
    const content = await readFile(file, 'utf8');
    if (content.includes('\r\n') || !content.endsWith('\n')) throw new SealwrapperError(`Formatting gate failed for ${relative(projectRoot, file)}: use LF line endings and a final newline`, 1);
    const loader = file.endsWith('.tsx') ? 'tsx' : /\.[cm]?ts$/.test(file) ? 'ts' : 'js';
    try { await esbuild.transform(content, { loader, sourcefile: relative(projectRoot, file), target: config.build.ecmaTarget }); }
    catch (error: unknown) { throw new SealwrapperError(`Source syntax gate failed for ${relative(projectRoot, file)}: ${error instanceof Error ? error.message : String(error)}`, 1); }
    const compatibility = await scanGojaCompatibility(content, relative(projectRoot, file));
    if (compatibility.length > 0) {
      throw new SealwrapperError(`Goja compatibility scan failed:\n${compatibility.map((item) => `${item.file}:${item.line}:${item.column} ${item.ruleId}: ${item.message}`).join('\n')}`, 1);
    }
  }
  const tests = await collect(projectRoot, join(projectRoot, 'tests', 'unit'), (name) => /\.test\.(?:[cm]?js|tsx?)$/.test(name));
  if (tests.length === 0) throw new SealwrapperError('JS release gate requires at least one tests/unit/*.test.{ts,js} file', 1);
  await runTests(process.execPath, ['--experimental-strip-types', '--test', ...tests], projectRoot, testTimeoutMs, maxTestOutputBytes);
}
