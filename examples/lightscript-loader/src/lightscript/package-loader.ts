import { parseToml } from './toml';
import type {
  DiagnosticReporter,
  LightScriptAuto,
  LightScriptDocument,
  LightScriptIndex,
  LightScriptPackageEnvelope,
  TomlValue,
} from './types';

export interface RuntimeModuleLoader {
  load(path: string): unknown;
}

export interface RuntimeDocumentLoadResult {
  documents: readonly LightScriptDocument[];
  requested: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function asIndex(value: unknown): LightScriptIndex | null {
  if (!isRecord(value)) return null;
  if (value['format'] !== 'sealdice-lightscript-index-v1') return null;
  if (!isStringArray(value['scripts'])) return null;
  return { format: value['format'], scripts: value['scripts'] };
}

function asEnvelope(value: unknown): LightScriptPackageEnvelope | null {
  if (!isRecord(value)) return null;
  if (value['format'] !== 'sealdice-lightscript-toml-v1') return null;
  if (typeof value['source'] !== 'string') return null;
  if (value['id'] !== undefined && typeof value['id'] !== 'string') return null;
  return {
    format: value['format'],
    ...(typeof value['id'] === 'string' ? { id: value['id'] } : {}),
    source: value['source'],
  };
}

export function isSafePackageFile(file: string): boolean {
  return (
    file.length > 0 &&
    file.endsWith('.toml.json') &&
    !file.includes('..') &&
    !file.includes('/') &&
    !file.includes('\\') &&
    !file.startsWith('.') &&
    !/^[A-Za-z]:/u.test(file)
  );
}

function packageIdFromFile(file: string): string {
  return file.slice(0, -'.toml.json'.length);
}

function valueAsStrings(value: TomlValue | undefined): readonly string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') return [];
      values.push(item);
    }
    return values;
  }
  return [];
}

function valueAsOptionalString(
  value: TomlValue | undefined,
): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normaliseAuto(
  fields: Record<string, TomlValue>,
  ordinal: number,
  documentID: string,
  file: string,
  reporter: DiagnosticReporter,
): LightScriptAuto | null {
  const keywordRegexp: RegExp[] = [];
  for (const source of valueAsStrings(fields['keywordRegexp'])) {
    try {
      keywordRegexp.push(new RegExp(source, 'u'));
    } catch (error) {
      reporter.report({
        code: 'invalid-trigger-regexp',
        file,
        message: `Invalid keywordRegexp: ${String(error)}`,
        packageId: documentID,
        section: ordinal,
        severity: 'error',
      });
      return null;
    }
  }
  const content = valueAsOptionalString(fields['content']);
  const program = valueAsOptionalString(fields['program']);
  return {
    ...(content === undefined ? {} : { content }),
    fields,
    keywordContained: valueAsStrings(fields['keywordContained']),
    keywordFull: valueAsStrings(fields['keywordFull']),
    keywordRegexp,
    ordinal,
    ...(program === undefined ? {} : { program }),
  };
}

function normaliseDocument(
  envelope: LightScriptPackageEnvelope,
  file: string,
  sequence: number,
  reporter: DiagnosticReporter,
): LightScriptDocument | null {
  const suppliedId = envelope.id?.trim();
  const id =
    suppliedId === undefined || suppliedId === ''
      ? packageIdFromFile(file)
      : suppliedId;
  if (!id) {
    reporter.report({
      code: 'invalid-package-id',
      file,
      message: 'The package id is empty',
      severity: 'error',
    });
    return null;
  }

  const parsed = parseToml(envelope.source, { file, reporter });
  if (parsed === null) return null;
  const defines: Record<string, string> = {};
  const autos: LightScriptAuto[] = [];
  for (const table of parsed.tables) {
    if (table.name === 'define') {
      const name = valueAsOptionalString(table.fields['name']);
      const content = valueAsOptionalString(table.fields['content']);
      if (name === undefined || content === undefined) {
        reporter.report({
          code: 'invalid-define',
          file,
          message: '[[define]] requires string name and content',
          packageId: id,
          section: table.ordinal,
          severity: 'warning',
        });
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(defines, name)) {
        reporter.report({
          code: 'duplicate-define',
          file,
          message: `The last [[define]] named ${name} wins`,
          packageId: id,
          section: table.ordinal,
          severity: 'warning',
        });
      }
      defines[name] = content;
      continue;
    }
    if (table.name === 'lua') {
      reporter.report({
        code: 'unsupported-lua-section',
        file,
        message:
          '[[lua]] is skipped; Lua hooks are not available in SealDice JS',
        packageId: id,
        section: table.ordinal,
        severity: 'warning',
      });
      continue;
    }
    if (table.name !== 'auto') continue;
    const auto = normaliseAuto(table.fields, autos.length, id, file, reporter);
    if (auto !== null) autos.push(auto);
  }
  return {
    autos,
    defines,
    file,
    id,
    root: parsed.root,
    sequence,
  };
}

export function loadDocuments(
  indexValue: unknown,
  loader: RuntimeModuleLoader,
  reporter: DiagnosticReporter,
): readonly LightScriptDocument[] {
  const index = asIndex(indexValue);
  if (index === null) {
    reporter.report({
      code: 'invalid-lightscript-index',
      message: 'lightscripts/index.json has an invalid format or scripts list',
      severity: 'error',
    });
    return [];
  }

  const documents: LightScriptDocument[] = [];
  const ids = new Set<string>();
  for (const file of index.scripts) {
    if (!isSafePackageFile(file)) {
      reporter.report({
        code: 'unsafe-package-path',
        file,
        message: 'Content-pack filenames must be plain *.toml.json names',
        severity: 'error',
      });
      continue;
    }
    let value: unknown;
    try {
      value = loader.load(`./lightscripts/${file}`);
    } catch (error) {
      reporter.report({
        code: 'package-load-failed',
        file,
        message: String(error),
        severity: 'error',
      });
      continue;
    }
    const envelope = asEnvelope(value);
    if (envelope === null) {
      reporter.report({
        code: 'invalid-package-envelope',
        file,
        message: 'Content package must contain format and string source',
        severity: 'error',
      });
      continue;
    }
    const document = normaliseDocument(
      envelope,
      file,
      documents.length,
      reporter,
    );
    if (document === null) continue;
    if (ids.has(document.id)) {
      reporter.report({
        code: 'duplicate-package-id',
        file,
        message: `Duplicate LightScript package id: ${document.id}`,
        packageId: document.id,
        severity: 'error',
      });
      continue;
    }
    ids.add(document.id);
    documents.push(document);
  }
  return documents;
}

declare const require: (path: string) => unknown;

const runtimeModuleLoader: RuntimeModuleLoader = {
  load(path: string): unknown {
    const prefix = './lightscripts/';
    if (!path.startsWith(prefix))
      throw new Error(`Unexpected LightScript asset path: ${path}`);
    // A schema-v1 sealpack stages non-executable data below assets/. The core
    // executes this bundle from scripts/, so this remains a fixed package-local
    // path; it never turns a document-supplied string into an arbitrary path.
    const assetPath = '../assets/lightscripts/' + path.slice(prefix.length);
    return require(assetPath);
  },
};

/** Loads only declared JSON modules from this package's assets; it never scans disk. */
export function loadRuntimeDocumentSet(
  reporter: DiagnosticReporter,
): RuntimeDocumentLoadResult {
  let index: unknown;
  try {
    index = runtimeModuleLoader.load('./lightscripts/index.json');
  } catch (error) {
    reporter.report({
      code: 'index-load-failed',
      message: String(error),
      severity: 'error',
    });
    return { documents: [], requested: 0 };
  }
  const parsedIndex = asIndex(index);
  return {
    documents: loadDocuments(index, runtimeModuleLoader, reporter),
    requested: parsedIndex?.scripts.length ?? 0,
  };
}

export function loadRuntimeDocuments(
  reporter: DiagnosticReporter,
): readonly LightScriptDocument[] {
  return loadRuntimeDocumentSet(reporter).documents;
}
