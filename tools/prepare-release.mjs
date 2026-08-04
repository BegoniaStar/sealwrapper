import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sha256(data) {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

async function command(program, args, options = {}) {
  try {
    return await execFileAsync(program, args, { cwd: projectRoot, encoding: 'utf8', ...options });
  } catch (error) {
    const detail = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim();
    throw new Error(`${program} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
}

function releaseDirectory() {
  const configured = process.env.SEALWRAPPER_RELEASE_DIRECTORY ?? 'artifacts';
  const directory = resolve(projectRoot, configured);
  if (directory !== join(projectRoot, configured) || configured.includes('..')) throw new Error('SEALWRAPPER_RELEASE_DIRECTORY must be a project-relative directory');
  return directory;
}

async function gitValue(args) {
  return (await command('git', args)).stdout.trim();
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) return appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  return Promise.resolve();
}

export async function prepareRelease() {
  const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
  if (tag && tag !== `v${pkg.version}`) throw new Error(`Release tag ${tag} must equal v${pkg.version} from package.json`);

  const directory = releaseDirectory();
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length > 0) throw new Error(`Release directory must be empty: ${directory}`);

  const packed = JSON.parse((await command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory])).stdout);
  if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== 'string') throw new Error('npm pack did not return one release tarball');
  const archive = join(directory, packed[0].filename);
  const archiveBytes = await readFile(archive);
  const checksum = `${archive}.sha256`;
  await writeFile(checksum, `${sha256(archiveBytes).slice('sha256:'.length)}  ${packed[0].filename}\n`, { mode: 0o644 });

  const sbom = join(directory, `${packed[0].name ?? pkg.name}-${pkg.version}.sbom.cdx.json`.replaceAll('/', '-'));
  const sbomData = (await command('npm', ['sbom', '--sbom-format', 'cyclonedx', '--omit=dev', '--package-lock-only'])).stdout;
  await writeFile(sbom, sbomData, { mode: 0o644 });

  const manifest = join(directory, `${packed[0].filename}.release.json`);
  const release = {
    format: 'sealwrapper.tool-release/v1',
    package: { name: pkg.name, version: pkg.version, private: pkg.private === true },
    source: { commit: await gitValue(['rev-parse', 'HEAD']), tree: await gitValue(['rev-parse', 'HEAD^{tree}']), tag: tag ?? null, packageLockSha256: sha256(await readFile(join(projectRoot, 'package-lock.json'))) },
    artifacts: [
      { name: packed[0].filename, bytes: archiveBytes.length, sha256: sha256(archiveBytes) },
      { name: packed[0].filename + '.sha256', sha256: sha256(await readFile(checksum)) },
      { name: sbom.split('/').at(-1), format: 'CycloneDX', sha256: sha256(await readFile(sbom)) },
    ],
  };
  await writeFile(manifest, `${JSON.stringify(release, null, 2)}\n`, { mode: 0o644 });

  await Promise.all([
    setOutput('archive', archive),
    setOutput('checksum', checksum),
    setOutput('sbom', sbom),
    setOutput('manifest', manifest),
  ]);
  process.stdout.write(`Prepared tool release: ${archive}\n`);
  return { archive, checksum, sbom, manifest, release };
}

if (import.meta.main) {
  prepareRelease().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
