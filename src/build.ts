import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SealwrapperError } from './errors.ts';

export async function buildBundle(root: string, config: any): Promise<Buffer> {
  if (!config.build || !config.sealpack.contents.scripts) throw new SealwrapperError('This project does not declare a JS bundle');
  const entry = join(root, config.build.entry);
  try {
    await readFile(entry);
  } catch {
    throw new SealwrapperError(`build.entry does not exist: ${config.build.entry}`);
  }
  let esbuild: any;
  try {
    esbuild = await import('esbuild');
  } catch {
    throw new SealwrapperError('JS bundles require the locked esbuild dependency; run npm ci', 3);
  }
  const result = await esbuild.build({
    absWorkingDir: root,
    bundle: true,
    entryPoints: [entry],
    format: 'iife',
    minify: false,
    platform: 'neutral',
    sourcemap: false,
    target: config.build.ecmaTarget,
    write: false,
  });
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
