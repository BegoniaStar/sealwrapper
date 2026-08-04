import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function npmEnvironment() {
  const env = { ...process.env };
  // npm 11 rejects a project-scoped install when an inherited allow-scripts
  // policy is combined with --ignore-scripts. The smoke test intentionally
  // executes no lifecycle scripts, so this ambient policy is irrelevant.
  delete env.npm_config_allow_scripts;
  delete env.NPM_CONFIG_ALLOW_SCRIPTS;
  return env;
}

async function command(program, args, options = {}) {
  try {
    return await execFileAsync(program, args, { encoding: 'utf8', ...options });
  } catch (error) {
    const detail = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim();
    throw new Error(`${program} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
}

async function main() {
  await access(join(projectRoot, 'dist', 'cli.js'));
  const sandbox = await mkdtemp(join(tmpdir(), 'sealwrapper-package-'));
  try {
    const packed = JSON.parse((await command('npm', ['pack', projectRoot, '--json', '--ignore-scripts', '--pack-destination', sandbox], { cwd: sandbox, env: npmEnvironment() })).stdout);
    assert.equal(packed.length, 1, 'npm pack must create exactly one tarball');
    const tarball = join(sandbox, packed[0].filename);
    await access(tarball);
    await command('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', join(sandbox, 'installed'), tarball], { cwd: sandbox, env: npmEnvironment() });

    const installed = join(sandbox, 'installed', 'node_modules', 'sealwrapper');
    await access(join(installed, 'dist', 'cli.js'));
    const contents = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    assert.equal(contents.name, 'sealwrapper');
    const binary = join(sandbox, 'installed', 'node_modules', '.bin', 'sealw');
    const result = await command(binary, ['--help'], { cwd: sandbox });
    assert.match(result.stdout, /Sealpack-only SealDice extension development tools/);
    process.stdout.write(`Packed-install CLI smoke passed: ${packed[0].filename}\n`);
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
