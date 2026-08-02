import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { SealwrapperError } from './errors.ts';

/**
 * esbuild follows imports (including symlinks) while resolving a bundle.  A
 * userscript must never be able to smuggle a file from outside the project
 * into the generated archive, so every file esbuild loads is checked against
 * the canonical project root.
 */
function isWithin(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

async function canonicalFile(path: string, root: string, label: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch {
    throw new SealwrapperError(`${label} does not exist: ${path}`);
  }
  if (!isWithin(root, resolved)) throw new SealwrapperError(`${label} resolves outside the project root: ${path}`);
  const details = await stat(resolved).catch(() => null);
  if (!details?.isFile()) throw new SealwrapperError(`${label} must be a regular file: ${path}`);
  return resolved;
}

function boundaryPlugin(projectRoot: string) {
  return {
    name: 'sealwrapper-project-boundary',
    setup(build: any) {
      // Reject an already-existing relative/absolute escape before esbuild's
      // resolver opens it.  The onLoad hook below remains the authoritative
      // check after extension and package resolution (for example `./dep`
      // becoming `./dep.ts`).
      build.onResolve({ filter: /^(?:\.{0,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/ }, async (args: { path: string; resolveDir: string }) => {
        const candidate = isAbsolute(args.path) ? args.path : resolve(args.resolveDir, args.path);
        let resolved: string;
        try {
          resolved = await realpath(candidate);
        } catch {
          return undefined;
        }
        if (!isWithin(projectRoot, resolved)) {
          throw new Error(`sealwrapper project boundary violation: imported path resolves outside the project root (${args.path})`);
        }
        return undefined;
      });
      // onLoad observes the final path chosen by esbuild, after extension,
      // package, tsconfig-path and symlink resolution have all happened.
      build.onLoad({ filter: /.*/ }, async (args: { namespace: string; path: string }) => {
        if (args.namespace !== 'file') return undefined;
        let resolved: string;
        try {
          resolved = await realpath(args.path);
        } catch {
          // Missing files are reported by esbuild's normal resolver.  Avoid
          // replacing its useful diagnostic with a boundary error.
          return undefined;
        }
        if (!isWithin(projectRoot, resolved)) {
          throw new Error(`sealwrapper project boundary violation: imported file resolves outside the project root (${args.path})`);
        }
        return undefined;
      });
    },
  };
}

export async function buildBundle(root: string, config: any): Promise<Buffer> {
  if (!config.build || !config.sealpack.contents.scripts) throw new SealwrapperError('This project does not declare a JS bundle');
  let projectRoot: string;
  try {
    projectRoot = await realpath(resolve(root));
  } catch {
    throw new SealwrapperError(`Project root does not exist: ${root}`);
  }
  const entryPath = resolve(projectRoot, config.build.entry);
  if (!isWithin(projectRoot, entryPath)) throw new SealwrapperError(`build.entry resolves outside the project root: ${config.build.entry}`);
  const entry = await canonicalFile(entryPath, projectRoot, `build.entry ${config.build.entry}`);
  let esbuild: any;
  try {
    esbuild = await import('esbuild');
  } catch {
    throw new SealwrapperError('JS bundles require the locked esbuild dependency; run npm ci', 3);
  }
  let result: any;
  try {
    result = await esbuild.build({
      absWorkingDir: projectRoot,
      bundle: true,
      entryPoints: [entry],
      format: 'iife',
      minify: false,
      platform: 'neutral',
      sourcemap: false,
      target: config.build.ecmaTarget,
      write: false,
      // The caller renders the structured build error.  Keeping esbuild
      // silent avoids duplicating a potentially very large plugin diagnostic
      // on stderr (especially for a rejected boundary import).
      logLevel: 'silent',
      plugins: [boundaryPlugin(projectRoot)],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/project boundary violation|outside the project root/i.test(message)) throw new SealwrapperError(message);
    throw error;
  }
  const output = result.outputFiles?.find((file: any) => file.path.endsWith('.js')) ?? result.outputFiles?.[0];
  if (!output) throw new SealwrapperError('esbuild did not produce a JavaScript bundle', 3);
  const header = [
    '// ==UserScript==',
    `// @name         ${config.package.name}`,
    `// @author       ${config.package.authors.join(', ')}`,
    `// @version      ${config.package.version}`,
    `// @description  ${config.package.description}`,
    `// @license      ${config.package.license}`,
    `// @homepageURL  ${config.package.homepage}`,
    '// ==/UserScript==',
    '',
  ].join('\n');
  return Buffer.concat([Buffer.from(header, 'utf8'), Buffer.from(output.contents)]);
}
