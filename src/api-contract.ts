import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as TypeScript from 'typescript';

import { canonicalJson } from './capabilities.ts';
import { SealwrapperError } from './errors.ts';
import { pinnedTarget } from './pinned-target.ts';

const require = createRequire(import.meta.url);
const ts: typeof import('typescript') = require('typescript');

export const apiTarget = '1.6.0';
export const apiScannerVersion = 2;
export const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type ApiEntry = {
  path: string;
  kind: string;
  goSignature?: string;
  arity?: number;
  factoryReturn?: string;
  source: string;
};

export type ApiInventory = {
  schemaVersion: number;
  scannerVersion: number;
  target: string;
  core: {
    commit: string;
    runtimeVersion: string;
    sourceDeclaredVersion: string;
    sourceFingerprint: string;
  };
  entries: readonly ApiEntry[];
  types: Readonly<Record<string, unknown>>;
};

export type SemanticOverride = {
  schemaVersion: number;
  target: string;
  template: string;
  declarationOnlyPaths: readonly string[];
  inventoryOnlyPaths: readonly string[];
};

export type ApiContractPaths = {
  directory: string;
  inventory: string;
  override: string;
  report: string;
  template: string;
  declaration: string;
};

type SurfaceEntry = { kind: 'function' | 'object'; minArity?: number };
type RawScanResult = { scannerVersion: number; sourceFingerprint: string; entries: ApiEntry[]; types: Record<string, unknown> };

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stablePrettyJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sort(record[key])]));
    }
    return item;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function comparePath(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SealwrapperError(`${label} must be an object`, 3);
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new SealwrapperError(`${label} must be a non-empty string`, 3);
  return value;
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new SealwrapperError(`${label} must be a string array`, 3);
  return value as string[];
}

function propertyName(name: TypeScript.PropertyName | TypeScript.BindingName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function minimumArity(parameters: readonly TypeScript.ParameterDeclaration[]): number {
  return parameters.filter((parameter) => !parameter.questionToken && !parameter.initializer && !parameter.dotDotDotToken).length;
}

function collectTypeSurface(type: TypeScript.TypeNode | undefined, path: string, into: Map<string, SurfaceEntry>) {
  if (!type) return;
  if (ts.isFunctionTypeNode(type)) {
    into.set(path, { kind: 'function', minArity: minimumArity(type.parameters) });
    return;
  }
  if (!ts.isTypeLiteralNode(type)) return;
  into.set(path, { kind: 'object' });
  for (const member of type.members) {
    if (ts.isPropertySignature(member)) {
      const name = propertyName(member.name);
      if (name) collectTypeSurface(member.type, `${path}.${name}`, into);
      continue;
    }
    if (ts.isMethodSignature(member)) {
      const name = propertyName(member.name);
      if (name) into.set(`${path}.${name}`, { kind: 'function', minArity: minimumArity(member.parameters) });
    }
  }
}

/** Extract the actual `seal.*` declaration surface without using regexes. */
export function declarationSurface(template: string): Map<string, SurfaceEntry> {
  const source = ts.createSourceFile('seal.d.ts.template', template, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const root = new Map<string, SurfaceEntry>();
  const seal = source.statements.find((statement): statement is TypeScript.ModuleDeclaration => ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name) && statement.name.text === 'seal');
  if (!seal || !seal.body || !ts.isModuleBlock(seal.body)) throw new SealwrapperError('Semantic type template must declare namespace seal', 3);
  for (const statement of seal.body.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      root.set(`seal.${statement.name.text}`, { kind: 'function', minArity: minimumArity(statement.parameters) });
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const name = propertyName(declaration.name);
      if (name) collectTypeSurface(declaration.type, `seal.${name}`, root);
    }
  }
  return root;
}

function sortedSet(values: readonly string[]): Set<string> {
  return new Set(values);
}

/**
 * Ensure the manually-reviewed semantic layer accounts for every AST export.
 * Go arity is an upper bound: optional JS arguments intentionally model Goja's
 * zero-value conversion and are therefore valid when TS requires fewer args.
 */
export function validateDeclarationCoverage(inventory: ApiInventory, semantic: SemanticOverride, template: string) {
  if (inventory.target !== apiTarget || semantic.target !== apiTarget) throw new SealwrapperError(`Only exact API target ${apiTarget} is supported`, 3);
  const surface = declarationSurface(template);
  const inventoryOnly = sortedSet(semantic.inventoryOnlyPaths);
  const declarationOnly = sortedSet(semantic.declarationOnlyPaths);
  const extracted = new Map(inventory.entries.map((entry) => [entry.path, entry]));
  const errors: string[] = [];
  for (const entry of inventory.entries) {
    if (entry.kind !== 'object' && entry.kind !== 'function') {
      errors.push(`${entry.path}: scanner returned unsupported kind ${entry.kind}`);
      continue;
    }
    const declaration = surface.get(entry.path);
    if (!declaration) {
      if (!inventoryOnly.has(entry.path)) errors.push(`${entry.path}: extracted API is missing from the semantic declaration`);
      continue;
    }
    if (declaration.kind !== entry.kind) errors.push(`${entry.path}: extracted ${entry.kind} conflicts with declared ${declaration.kind}`);
    if (entry.kind === 'function' && declaration.kind === 'function' && (declaration.minArity ?? 0) > (entry.arity ?? 0)) {
      errors.push(`${entry.path}: declaration requires ${String(declaration.minArity)} arguments but Go binding accepts ${String(entry.arity ?? 0)}`);
    }
  }
  for (const path of surface.keys()) {
    if (!extracted.has(path) && !declarationOnly.has(path)) errors.push(`${path}: declaration has no matching extracted API`);
  }
  for (const path of inventoryOnly) if (!extracted.has(path)) errors.push(`${path}: inventoryOnlyPaths names no extracted API`);
  for (const path of declarationOnly) if (!surface.has(path)) errors.push(`${path}: declarationOnlyPaths names no declared API`);
  if (errors.length) throw new SealwrapperError(`Type contract coverage failed:\n${errors.sort(comparePath).join('\n')}`, 3);
}

export function apiInventoryDigest(inventory: ApiInventory): string {
  return sha256(canonicalJson(inventory));
}

export function semanticOverrideDigest(semantic: SemanticOverride): string {
  return sha256(canonicalJson(semantic));
}

/** Render the generated public declaration from inventory plus semantic template. */
export function renderApiDeclaration(inventory: ApiInventory, semantic: SemanticOverride, template: string): string {
  validateDeclarationCoverage(inventory, semantic, template);
  return [
    '/**',
    ' * Generated from the lock-pinned SealDice API inventory. Do not edit.',
    ` * Target: SealDice ${inventory.target}`,
    ` * Runtime: ${inventory.core.runtimeVersion}`,
    ` * Source core: ${inventory.core.commit}`,
    ` * Source fingerprint: ${inventory.core.sourceFingerprint}`,
    ` * API inventory: ${apiInventoryDigest(inventory)}`,
    ` * Semantic override: ${semanticOverrideDigest(semantic)}`,
    ' */',
    '',
    template,
  ].join('\n');
}

export function renderApiReport(inventory: ApiInventory, semantic: SemanticOverride): string {
  const rows = [...inventory.entries].sort((left, right) => comparePath(left.path, right.path)).map((entry) => {
    const signature = entry.goSignature ? `\`${entry.goSignature}\`` : '';
    return `| \`${entry.path}\` | ${entry.kind} | ${signature} | \`${entry.source}\` |`;
  });
  return [
    `# SealDice ${inventory.target} API Inventory`,
    '',
    `- Core commit: \`${inventory.core.commit}\``,
    `- Distribution runtime: \`${inventory.core.runtimeVersion}\``,
    `- Source declaration: \`${inventory.core.sourceDeclaredVersion}\``,
    `- Source fingerprint: \`${inventory.core.sourceFingerprint}\``,
    `- Scanner version: \`${String(inventory.scannerVersion)}\``,
    `- Inventory digest: \`${apiInventoryDigest(inventory)}\``,
    `- Semantic override digest: \`${semanticOverrideDigest(semantic)}\``,
    '',
    '| Path | Kind | Go signature | Source |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

function comparableEntry(entry: ApiEntry | undefined): string {
  if (!entry) return '';
  return canonicalJson({ arity: entry.arity ?? 0, factoryReturn: entry.factoryReturn ?? '', goSignature: entry.goSignature ?? '', kind: entry.kind, path: entry.path });
}

/** Human-readable inventory drift excluding line movement alone. */
export function compareApiInventories(expected: ApiInventory, actual: ApiInventory): string[] {
  const before = new Map(expected.entries.map((entry) => [entry.path, entry]));
  const after = new Map(actual.entries.map((entry) => [entry.path, entry]));
  const changes: string[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort(comparePath)) {
    const left = before.get(path), right = after.get(path);
    if (!left) changes.push(`Added: ${path}`);
    else if (!right) changes.push(`Removed: ${path}`);
    else if (comparableEntry(left) !== comparableEntry(right)) changes.push(`Changed: ${path}`);
  }
  if (expected.core.sourceFingerprint !== actual.core.sourceFingerprint) changes.push(`Source fingerprint: ${expected.core.sourceFingerprint} -> ${actual.core.sourceFingerprint}`);
  return changes;
}

export function apiContractPaths(root = toolRoot): ApiContractPaths {
  const directory = join(root, 'api', 'sealdice', apiTarget);
  return {
    directory,
    inventory: join(directory, 'inventory.json'),
    override: join(directory, 'semantic-override.json'),
    report: join(directory, 'report.md'),
    template: join(directory, 'seal.d.ts.template'),
    declaration: join(root, 'types', 'sealdice', apiTarget, 'seal.d.ts'),
  };
}

async function readJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new SealwrapperError(`Unable to read ${label}: ${(error as Error).message}`, 3);
  }
}

function parseInventory(raw: unknown): ApiInventory {
  const value = asRecord(raw, 'API inventory');
  const core = asRecord(value.core, 'API inventory.core');
  if (value.schemaVersion !== 1 || value.scannerVersion !== apiScannerVersion || value.target !== apiTarget) throw new SealwrapperError(`API inventory must use schemaVersion 1, scanner ${String(apiScannerVersion)}, and target ${apiTarget}`, 3);
  if (!Array.isArray(value.entries)) throw new SealwrapperError('API inventory.entries must be an array', 3);
  const entries = value.entries.map((item, index) => {
    const entry = asRecord(item, `API inventory.entries[${String(index)}]`);
    const result: ApiEntry = { path: asString(entry.path, 'API entry path'), kind: asString(entry.kind, 'API entry kind'), source: asString(entry.source, 'API entry source') };
    if (entry.goSignature !== undefined) result.goSignature = asString(entry.goSignature, 'API entry goSignature');
    if (entry.factoryReturn !== undefined) result.factoryReturn = asString(entry.factoryReturn, 'API entry factoryReturn');
    if (entry.arity !== undefined) {
      if (typeof entry.arity !== 'number' || !Number.isInteger(entry.arity) || entry.arity < 0) throw new SealwrapperError('API entry arity must be a non-negative integer', 3);
      result.arity = entry.arity;
    }
    return result;
  });
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length || paths.some((path) => !path.startsWith('seal.'))) throw new SealwrapperError('API inventory paths must be unique seal.* entries', 3);
  return {
    schemaVersion: 1,
    scannerVersion: apiScannerVersion,
    target: apiTarget,
    core: {
      commit: asString(core.commit, 'API inventory core.commit'),
      runtimeVersion: asString(core.runtimeVersion, 'API inventory core.runtimeVersion'),
      sourceDeclaredVersion: asString(core.sourceDeclaredVersion, 'API inventory core.sourceDeclaredVersion'),
      sourceFingerprint: asString(core.sourceFingerprint, 'API inventory core.sourceFingerprint'),
    },
    entries,
    types: asRecord(value.types, 'API inventory.types'),
  };
}

function parseSemanticOverride(raw: unknown): SemanticOverride {
  const value = asRecord(raw, 'semantic override');
  if (value.schemaVersion !== 1 || value.target !== apiTarget) throw new SealwrapperError(`Semantic override must use schemaVersion 1 and target ${apiTarget}`, 3);
  return {
    schemaVersion: 1,
    target: apiTarget,
    template: asString(value.template, 'semantic override.template'),
    declarationOnlyPaths: asStringArray(value.declarationOnlyPaths, 'semantic override.declarationOnlyPaths'),
    inventoryOnlyPaths: asStringArray(value.inventoryOnlyPaths, 'semantic override.inventoryOnlyPaths'),
  };
}

function verifyPinnedInventory(inventory: ApiInventory) {
  if (inventory.core.commit !== pinnedTarget.core.commit || inventory.core.runtimeVersion !== pinnedTarget.core.runtimeVersion || inventory.core.sourceDeclaredVersion !== pinnedTarget.core.sourceDeclaredVersion) {
    throw new SealwrapperError('API inventory provenance does not match the lock-pinned 1.6.0 target', 3);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { mode: 0o644 });
  await rename(temporary, path);
}

export type LoadedApiContract = {
  declaration: string;
  inventory: ApiInventory;
  report: string;
  semantic: SemanticOverride;
  template: string;
};

/** Load and verify all checked-in exact-target API contract artifacts. */
export async function loadApiContract(root = toolRoot): Promise<LoadedApiContract> {
  const paths = apiContractPaths(root);
  const inventory = parseInventory(await readJson(paths.inventory, 'API inventory'));
  verifyPinnedInventory(inventory);
  const semantic = parseSemanticOverride(await readJson(paths.override, 'semantic override'));
  if (semantic.template !== relative(root, paths.template).replaceAll('\\', '/')) throw new SealwrapperError('Semantic override template path is invalid', 3);
  const template = await readFile(paths.template, 'utf8').catch((error) => { throw new SealwrapperError(`Unable to read semantic declaration template: ${(error as Error).message}`, 3); });
  const declaration = renderApiDeclaration(inventory, semantic, template);
  const report = renderApiReport(inventory, semantic);
  if (!(await fileExists(paths.declaration)) || await readFile(paths.declaration, 'utf8') !== declaration) throw new SealwrapperError('Generated SealDice declaration is stale; run sealw types update --write from a project with a managed core', 3);
  if (!(await fileExists(paths.report)) || await readFile(paths.report, 'utf8') !== report) throw new SealwrapperError('Generated SealDice API report is stale; run sealw types update --write from a project with a managed core', 3);
  return { declaration, inventory, report, semantic, template };
}

function run(program: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

async function requirePinnedGo(target: any) {
  const version = await run('go', ['version'], toolRoot).catch(() => null);
  if (!version || version.code !== 0 || !version.stdout.includes(`go${target.testOverlay.goVersion} `)) {
    throw new SealwrapperError(`Go ${target.testOverlay.goVersion} is required for the API scanner`, 2);
  }
}

/** Scan only a lock-managed core worktree; callers never supply arbitrary core paths. */
export async function scanManagedCoreApi(worktree: string, target: any): Promise<ApiInventory> {
  if (target.core.commit !== pinnedTarget.core.commit || target.core.runtimeVersion !== pinnedTarget.core.runtimeVersion) throw new SealwrapperError('API scanner only accepts the lock-pinned exact target', 3);
  await requirePinnedGo(target);
  const scanner = join(toolRoot, 'tools', 'seal-api-scan');
  const result = await run('go', ['run', '.', '--core', worktree], scanner);
  if (result.code !== 0) throw new SealwrapperError(`Go AST API scan failed:\n${(result.stderr || result.stdout).trim()}`, 3);
  let raw: RawScanResult;
  try {
    raw = JSON.parse(result.stdout) as RawScanResult;
  } catch (error) {
    throw new SealwrapperError(`Go AST API scanner returned invalid JSON: ${(error as Error).message}`, 3);
  }
  if (raw.scannerVersion !== apiScannerVersion || !Array.isArray(raw.entries) || !raw.types || typeof raw.sourceFingerprint !== 'string') throw new SealwrapperError('Go AST API scanner returned an invalid inventory', 3);
  const inventory: ApiInventory = {
    schemaVersion: 1,
    scannerVersion: apiScannerVersion,
    target: apiTarget,
    core: { commit: target.core.commit, runtimeVersion: target.core.runtimeVersion, sourceDeclaredVersion: target.core.sourceDeclaredVersion, sourceFingerprint: raw.sourceFingerprint },
    entries: [...raw.entries].sort((left, right) => comparePath(left.path, right.path)),
    types: raw.types,
  };
  return parseInventory(inventory);
}

/** Rewrite generated inventory, declaration and report after an explicit audit. */
export async function updateApiContract(worktree: string, target: any, root = toolRoot): Promise<LoadedApiContract> {
  if (root !== toolRoot) throw new SealwrapperError('API contract updates can only write sealwrapper-owned source assets', 2);
  const paths = apiContractPaths(root);
  const semantic = parseSemanticOverride(await readJson(paths.override, 'semantic override'));
  const template = await readFile(paths.template, 'utf8');
  const inventory = await scanManagedCoreApi(worktree, target);
  validateDeclarationCoverage(inventory, semantic, template);
  const declaration = renderApiDeclaration(inventory, semantic, template);
  const report = renderApiReport(inventory, semantic);
  await Promise.all([
    writeAtomic(paths.inventory, stablePrettyJson(inventory)),
    writeAtomic(paths.declaration, declaration),
    writeAtomic(paths.report, report),
  ]);
  return { declaration, inventory, report, semantic, template };
}

/** Compare the checked-in inventory with a fresh scan of an already-verified worktree. */
export async function auditApiContract(worktree: string, target: any, root = toolRoot): Promise<{ inventory: ApiInventory; differences: string[] }> {
  const expected = await loadApiContract(root);
  const actual = await scanManagedCoreApi(worktree, target);
  return { inventory: actual, differences: compareApiInventories(expected.inventory, actual) };
}
