import { execFile, spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { SealwrapperError } from './errors.ts';
import { pinnedTarget } from './pinned-target.ts';

const toolRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scannerRoot = join(toolRoot, 'tools', 'seal-api-scan');
const execFileAsync = promisify(execFile);

export type ReplyGrammar = {
  condTypes: string[];
  matchTypes: string[];
  matchOps: string[];
  resultTypes: string[];
};

export type ReplyGrammarAudit = {
  production: ReplyGrammar;
  overlay: ReplyGrammar;
};

function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonical(values: readonly string[]): string {
  return JSON.stringify([...values].sort(compare));
}

function normalize(value: unknown, label: string): ReplyGrammar {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SealwrapperError(`${label} must be an object`, 3);
  const record = value as Record<string, unknown>;
  const read = (name: keyof ReplyGrammar) => {
    const values = record[name];
    if (!Array.isArray(values) || !values.every((item) => typeof item === 'string')) throw new SealwrapperError(`${label}.${name} must be a string array`, 3);
    return [...new Set(values as string[])].sort(compare);
  };
  return { condTypes: read('condTypes'), matchTypes: read('matchTypes'), matchOps: read('matchOps'), resultTypes: read('resultTypes') };
}

function compatibilityDifferences(actual: ReplyGrammarAudit): string[] {
  const differences: string[] = [];
  const production = actual.production;
  const overlay = actual.overlay;
  for (const field of ['condTypes', 'matchTypes', 'matchOps', 'resultTypes'] as const) {
    const core = new Set(production[field]);
    const checker = new Set(overlay[field]);
    for (const value of [...core].sort(compare)) if (!checker.has(value)) differences.push(`overlay.${field} is missing production value ${value}`);
    for (const value of [...checker].sort(compare)) if (!core.has(value)) differences.push(`overlay.${field} accepts unsupported production value ${value}`);
  }
  return differences.sort(compare);
}

export function compareReplyGrammar(expected: ReplyGrammarAudit, actual: ReplyGrammarAudit): string[] {
  const differences: string[] = [];
  for (const side of ['production', 'overlay'] as const) {
    for (const field of ['condTypes', 'matchTypes', 'matchOps', 'resultTypes'] as const) {
      if (canonical(expected[side][field]) !== canonical(actual[side][field])) differences.push(`${side}.${field} changed`);
    }
  }
  differences.push(...compatibilityDifferences(actual));
  return differences.sort(compare);
}

export function validateReplyGrammar(grammar: ReplyGrammarAudit): string[] {
  return compatibilityDifferences(grammar);
}

function runScanner(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('go', ['run', '.', ...args], { cwd: scannerRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

async function assertPinnedGo() {
  let output: string;
  try {
    output = (await execFileAsync('go', ['version'])).stdout;
  } catch (error) {
    throw new SealwrapperError(`Go ${pinnedTarget.testOverlay.goVersion} is required for reply grammar audit: ${(error as Error).message}`, 2);
  }
  if (!output.includes(`go${pinnedTarget.testOverlay.goVersion} `)) {
    throw new SealwrapperError(`Go ${pinnedTarget.testOverlay.goVersion} is required for reply grammar audit; found ${output.trim() || 'unavailable'}`, 2);
  }
}

async function overlayPath(worktree: string): Promise<string> {
  const directory = join(worktree, 'dice');
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
  const candidate = entries
    .filter((entry) => entry.isFile() && /^zz_sealwrapper_bridge.*_test\.go$/u.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort(compare)[0];
  if (!candidate || !(await access(candidate).then(() => true).catch(() => false))) throw new SealwrapperError('Managed core test-only bridge source is missing; run core sync', 3);
  return candidate;
}

/**
 * Audit the real target parser grammar against the signed test-only checker.
 * This is deliberately read-only: it does not rewrite the overlay or its
 * lock digest. A new core discriminant must be reviewed and then land in a
 * new signed overlay revision.
 */
export async function auditReplyGrammar(worktree: string): Promise<{ grammar: ReplyGrammarAudit; differences: string[] }> {
  await assertPinnedGo();
  const overlay = await overlayPath(worktree);
  const result = await runScanner(['--core', worktree, '--reply-grammar', '--overlay', overlay]);
  if (result.code !== 0) throw new SealwrapperError(`Go reply grammar audit failed:\n${(result.stderr || result.stdout).trim()}`, 3);
  let raw: unknown;
  try { raw = JSON.parse(result.stdout); } catch (error) { throw new SealwrapperError(`Go reply grammar scanner returned invalid JSON: ${(error as Error).message}`, 3); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new SealwrapperError('Go reply grammar scanner returned an invalid result', 3);
  const record = raw as Record<string, unknown>;
  const grammar = { production: normalize(record.production, 'reply grammar.production'), overlay: normalize(record.overlay, 'reply grammar.overlay') };
  const differences = validateReplyGrammar(grammar);
  return { grammar, differences };
}
