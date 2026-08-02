import type { Diagnostic, DiagnosticReporter } from './types';

export interface DiagnosticLogSink {
  error(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

function diagnosticKey(diagnostic: Diagnostic): string {
  return [
    diagnostic.severity,
    diagnostic.code,
    diagnostic.packageId ?? '',
    diagnostic.file ?? '',
    String(diagnostic.section ?? ''),
    diagnostic.message,
  ].join('\u0000');
}

export class DiagnosticCollector implements DiagnosticReporter {
  private readonly diagnostics: Diagnostic[] = [];

  private readonly seen = new Set<string>();

  public report(diagnostic: Diagnostic): void {
    const key = diagnosticKey(diagnostic);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.diagnostics.push(diagnostic);
  }

  public all(): readonly Diagnostic[] {
    return this.diagnostics;
  }

  public summary(): string {
    const errors = this.diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'error',
    ).length;
    const warnings = this.diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'warning',
    ).length;
    return `LightScript: ${String(errors)} errors, ${String(warnings)} warnings`;
  }
}

/** Formats a diagnostic without including TOML source or received messages. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = [
    diagnostic.packageId === undefined ? '' : `package=${diagnostic.packageId}`,
    diagnostic.file === undefined ? '' : `file=${diagnostic.file}`,
    diagnostic.section === undefined
      ? ''
      : `section=${String(diagnostic.section)}`,
  ].filter((part) => part !== '');
  const stack =
    diagnostic.stack === undefined || diagnostic.stack.length === 0
      ? ''
      : ` stack=${diagnostic.stack.map((frame) => frame.command).join('>')}`;
  return `[LightScript][${diagnostic.severity}][${diagnostic.code}]${
    location.length === 0 ? '' : ` ${location.join(' ')}`
  }: ${diagnostic.message}${stack}`;
}

export function logDiagnostic(
  diagnostic: Diagnostic,
  sink: DiagnosticLogSink,
): void {
  const line = formatDiagnostic(diagnostic);
  switch (diagnostic.severity) {
    case 'error':
      sink.error(line);
      break;
    case 'warning':
      sink.warn(line);
      break;
    case 'info':
      sink.info(line);
      break;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
