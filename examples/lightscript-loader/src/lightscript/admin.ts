import { DiagnosticCollector, formatDiagnostic } from './diagnostics';
import { loadDocuments } from './package-loader';
import type { Diagnostic, LightScriptDocument } from './types';

const runtimeDebugFile = 'runtime-debug.toml.json';
const runtimeDebugID = 'runtime-debug';

export const maxRuntimeTomlCharacters = 24_000;

export interface RuntimeTomlParseResult {
  diagnostics: readonly Diagnostic[];
  documents: readonly LightScriptDocument[];
}

function diagnosticsText(diagnostics: readonly Diagnostic[]): string {
  const lines = diagnostics
    .slice(0, 3)
    .map((diagnostic) =>
      formatDiagnostic(diagnostic).replace(/^\[LightScript\]/u, ''),
    );
  const remaining = diagnostics.length - lines.length;
  return `${lines.join('\n')}${
    remaining > 0 ? `\n…另有 ${String(remaining)} 条诊断` : ''
  }`;
}

/** Parses a TOML snippet through the same package normalisation path as packs. */
export function parseRuntimeToml(source: string): RuntimeTomlParseResult {
  const reporter = new DiagnosticCollector();
  const documents = loadDocuments(
    {
      format: 'sealdice-lightscript-index-v1',
      scripts: [runtimeDebugFile],
    },
    {
      load: () => ({
        format: 'sealdice-lightscript-toml-v1',
        id: runtimeDebugID,
        source,
      }),
    },
    reporter,
  );
  return { diagnostics: reporter.all(), documents };
}

/** Returns a concise operator-facing report; runtime snippets are never run. */
export function formatRuntimeTomlParse(result: RuntimeTomlParseResult): string {
  const errors = result.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error',
  );
  if (result.documents.length === 0 || errors.length > 0) {
    return `回雪：解析失败。\n${diagnosticsText(result.diagnostics)}`;
  }
  const document = result.documents[0];
  if (document === undefined) return '回雪：解析失败。未生成内容包。';
  const warnings = result.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'warning',
  );
  const summary = `回雪：解析成功（顶层字段 ${String(
    Object.keys(document.root).length,
  )}，define ${String(Object.keys(document.defines).length)}，auto ${String(
    document.autos.length,
  )}）。`;
  return warnings.length === 0
    ? summary
    : `${summary}\n${diagnosticsText(warnings)}`;
}

export function sourceAfterSubcommand(
  rawArguments: string,
  subcommand: string,
): string | null {
  const leading = rawArguments.trimStart();
  if (!leading.startsWith(subcommand)) return null;
  const boundary = leading[subcommand.length];
  if (boundary !== undefined && !/\s/u.test(boundary)) return null;
  return leading.slice(subcommand.length).trimStart();
}

function whitelistEntries(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(/[\s,，;；]+/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  );
}

/** Dice masters always pass; whitelist entries match the full sender ID. */
export function isManagementAllowed(
  privilegeLevel: number,
  senderID: string,
  whitelist: string,
): boolean {
  if (privilegeLevel >= 100) return true;
  const entries = whitelistEntries(whitelist);
  if (entries.has(senderID)) return true;
  const qq = /^QQ:(\d+)$/u.exec(senderID);
  return qq !== null && entries.has(qq[1] ?? '');
}
