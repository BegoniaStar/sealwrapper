import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const roots = ['src', 'tests', 'tools'];
const forbiddenPatterns: readonly [RegExp, string][] = [
  [new RegExp(`@ts-${'ignore'}\\b`, 'u'), 'TypeScript suppression comments are forbidden'],
  [new RegExp(`@ts-${'expect-error'}\\b`, 'u'), 'TypeScript suppression comments are forbidden'],
  [new RegExp(`\\b${'ev'}${'al'}\\s*\\(`, 'u'), 'Dynamic code evaluation is forbidden'],
  [new RegExp(`\\bnew\\s+${'Fun'}${'ction'}\\s*\\(`, 'u'), 'Function constructors are forbidden'],
];

async function collect(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`lint input must not be a symbolic link: ${relative(process.cwd(), path)}`);
    if (stat.isDirectory()) files.push(...await collect(path));
    else if (stat.isFile() && /\.tsx?$/u.test(entry.name)) files.push(path);
  }
  return files;
}

export async function lintProject(root = process.cwd()): Promise<string[]> {
  const violations: string[] = [];
  const checked: string[] = [];
  for (const directory of roots) {
    const files = await collect(join(root, directory));
    for (const path of files) {
      checked.push(relative(root, path));
      const source = await readFile(path, 'utf8');
      if (source.includes('\r\n')) violations.push(`${relative(root, path)}: CRLF line endings`);
      if (!source.endsWith('\n')) violations.push(`${relative(root, path)}: missing final newline`);
      if (/^[ \t]+$/mu.test(source)) violations.push(`${relative(root, path)}: trailing whitespace`);
      for (const [pattern, message] of forbiddenPatterns) if (pattern.test(source)) violations.push(`${relative(root, path)}: ${message}`);
    }
  }
  if (violations.length) throw new Error(`Source lint failed:\n${violations.join('\n')}`);
  return checked;
}

if (import.meta.main) {
  lintProject().then(() => process.stdout.write('Source lint passed\n')).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
