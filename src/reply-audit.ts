import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SealwrapperError } from './errors.ts';
import { pinnedTarget, type TargetDescriptor } from './pinned-target.ts';
import { runProcess, type ProcessResult } from './process.ts';

const toolRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scannerRoot = join(toolRoot, 'tools', 'seal-api-scan');
const scannerTimeoutMilliseconds = 120_000;
const scannerOutputLimitBytes = 8 * 1024 * 1024;

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

async function runScanner(args: string[]): Promise<ProcessResult> {
  return await runProcess('go', ['run', '.', ...args], { cwd: scannerRoot, timeoutMs: scannerTimeoutMilliseconds, maxOutputBytes: scannerOutputLimitBytes });
}

function scannerFailure(label: string, result: ProcessResult): SealwrapperError | undefined {
  if (result.timedOut) return new SealwrapperError(`${label} timed out after ${scannerTimeoutMilliseconds}ms`, 3);
  if (result.outputExceeded) return new SealwrapperError(`${label} exceeded the ${scannerOutputLimitBytes} byte output limit`, 3);
  return undefined;
}

async function assertPinnedGo(target: TargetDescriptor) {
  let result: ProcessResult;
  try {
    result = await runProcess('go', ['version'], { cwd: scannerRoot, timeoutMs: scannerTimeoutMilliseconds, maxOutputBytes: scannerOutputLimitBytes });
  } catch (error) {
    throw new SealwrapperError(`Go ${target.testOverlay.goVersion} is required for reply grammar audit: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  const failure = scannerFailure('Go version probe', result);
  if (failure) throw failure;
  if (result.code !== 0 || !result.stdout.includes(`go${target.testOverlay.goVersion} `)) {
    throw new SealwrapperError(`Go ${target.testOverlay.goVersion} is required for reply grammar audit; found ${(result.stdout || result.stderr).trim() || 'unavailable'}`, 2);
  }
}

async function overlayPath(worktree: string, target: TargetDescriptor): Promise<string> {
  const candidates = new Set<string>();
  for (const patch of target.testOverlay.patches) {
    const source = join(scannerRoot, '..', '..', patch.path);
    const data = await readFile(source, 'utf8').catch(() => '');
    for (const match of data.matchAll(/^diff --git a\/(dice\/[^\n]+_test\.go) b\/dice\/[^\n]+_test\.go$/gmu)) candidates.add(match[1]);
  }
  const existing = [...candidates].sort(compare).map((path) => join(worktree, path));
  for (const candidate of existing) if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  throw new SealwrapperError(`Managed core test-only bridge source for target ${target.id} is missing; run core sync`, 3);
}

/**
 * Audit the real target parser grammar against the signed test-only checker.
 * This is deliberately read-only: it does not rewrite the overlay or its
 * lock digest. A new core discriminant must be reviewed and then land in a
 * new signed overlay revision.
 */
export async function auditReplyGrammar(worktree: string, target: TargetDescriptor = pinnedTarget): Promise<{ grammar: ReplyGrammarAudit; differences: string[] }> {
  await assertPinnedGo(target);
  const overlay = await overlayPath(worktree, target);
  const result = await runScanner(['--core', worktree, '--reply-grammar', '--overlay', overlay]);
  const failure = scannerFailure('Go reply grammar audit', result);
  if (failure) throw failure;
  if (result.code !== 0) throw new SealwrapperError(`Go reply grammar audit failed:\n${(result.stderr || result.stdout).trim()}`, 3);
  let raw: unknown;
  try { raw = JSON.parse(result.stdout); } catch (error) { throw new SealwrapperError(`Go reply grammar scanner returned invalid JSON: ${(error as Error).message}`, 3); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new SealwrapperError('Go reply grammar scanner returned an invalid result', 3);
  const record = raw as Record<string, unknown>;
  const grammar = { production: normalize(record.production, 'reply grammar.production'), overlay: normalize(record.overlay, 'reply grammar.overlay') };
  const differences = validateReplyGrammar(grammar);
  return { grammar, differences };
}
