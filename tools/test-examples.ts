import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

type RunResult = { code: number };

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const examplesRoot = join(toolRoot, 'examples');
const cliPath = join(toolRoot, 'src', 'cli.ts');

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function run(projectRoot: string, args: string[], planOnly: boolean): Promise<RunResult> {
  const label = relative(toolRoot, projectRoot) || '.';
  process.stdout.write(`[examples] ${label}: sealw ${args.join(' ')}\n`);
  if (planOnly) return { code: 0 };
  return await new Promise<RunResult>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', cliPath, ...args], {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code: code ?? 1 }));
  });
}

async function runRequired(projectRoot: string, args: string[], planOnly: boolean) {
  const result = await run(projectRoot, args, planOnly);
  if (result.code !== 0) throw new Error(`${relative(toolRoot, projectRoot)} failed: sealw ${args.join(' ')}`);
}

async function unitTests(projectRoot: string): Promise<string[]> {
  const directory = join(projectRoot, 'tests', 'unit');
  if (!(await exists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.test\.(?:[cm]?js|tsx?)$/u.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

async function projects(): Promise<string[]> {
  const entries = await readdir(examplesRoot, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
    if (!entry.isDirectory()) continue;
    const root = join(examplesRoot, entry.name);
    if (await exists(join(root, 'seal.config.json'))) result.push(root);
  }
  return result;
}

function optionValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes('--offline');
  const planOnly = args.includes('--plan');
  const selected = optionValue(args, '--project');
  const all = await projects();
  const chosen = selected ? all.filter((root) => root === join(examplesRoot, selected) || root.endsWith(`/${selected}`)) : all;
  if (chosen.length === 0) throw new Error(selected ? `example project not found: ${selected}` : 'no example projects found');

  let completed = 0;
  for (const projectRoot of chosen) {
    const config = JSON.parse(await readFile(join(projectRoot, 'seal.config.json'), 'utf8')) as { build?: unknown };
    if (offline) await runRequired(projectRoot, ['core', 'verify', '--target', '1.6.0'], planOnly);
    else await runRequired(projectRoot, ['core', 'sync', '--target', '1.6.0'], planOnly);
    await runRequired(projectRoot, ['types', 'sync', '--target', '1.6.0'], planOnly);
    await runRequired(projectRoot, ['types', 'verify', '--target', '1.6.0'], planOnly);
    await runRequired(projectRoot, ['types', 'audit', '--target', '1.6.0'], planOnly);
    if (config.build) await runRequired(projectRoot, ['typecheck', '--target', '1.6.0'], planOnly);

    const tests = await unitTests(projectRoot);
    if (tests.length > 0) {
      const label = relative(toolRoot, projectRoot);
      process.stdout.write(`[examples] ${label}: node --test ${tests.map((path) => relative(projectRoot, path)).join(' ')}\n`);
      if (!planOnly) {
        const result = await new Promise<RunResult>((resolvePromise, reject) => {
          const child = spawn(process.execPath, ['--experimental-strip-types', '--test', ...tests], { cwd: projectRoot, env: process.env, stdio: 'inherit' });
          child.once('error', reject);
          child.once('close', (code) => resolvePromise({ code: code ?? 1 }));
        });
        if (result.code !== 0) throw new Error(`${label} unit tests failed`);
      }
    }

    await runRequired(projectRoot, ['resource', 'check', '--target', '1.6.0'], planOnly);
    // Every release-marked example scenario also exercises the offline report
    // path. JSON remains authoritative; SVG/HTML/PNG are diagnostic outputs
    // under .seal/reports and never affect the package or assertions.
    const scenarioArgs = ['scenario', 'test', '--target', '1.6.0', '--release', '--offline', '--render', '--png'];
    await runRequired(projectRoot, scenarioArgs, planOnly);
    completed += 1;
    process.stdout.write(`[examples] passed: ${relative(toolRoot, projectRoot)}\n`);
  }
  process.stdout.write(`[examples] ${completed}/${chosen.length} project(s) passed\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { projects, unitTests };
