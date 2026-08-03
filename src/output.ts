import { escapeXml } from './xml.ts';

export type OutputFormat = 'text' | 'json' | 'junit';

export type OutputEnvelope = {
  format: 'sealwrapper.cli/v1';
  command: string;
  ok: boolean;
  messages: string[];
  error?: { message: string; exitCode?: number };
};

export function parseOutputFormat(value: string | undefined): OutputFormat | undefined {
  if (value === undefined) return undefined;
  if (value === 'text' || value === 'json' || value === 'junit') return value;
  throw new Error(`Unsupported output format: ${value}; expected text, json, or junit`);
}

function cdata(value: string): string {
  return `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

export function renderOutput(format: OutputFormat, command: string, ok: boolean, messages: readonly string[], error?: { message: string; exitCode?: number }): string {
  const envelope: OutputEnvelope = { format: 'sealwrapper.cli/v1', command, ok, messages: [...messages], ...(error ? { error } : {}) };
  if (format === 'json') return `${JSON.stringify(envelope, null, 2)}\n`;
  const failure = error ? `<failure message="${escapeXml(error.message)}">${cdata(error.message)}</failure>` : '';
  const body = messages.length ? `<system-out>${cdata(messages.join('\n'))}</system-out>` : '';
  return `<testsuite name="sealwrapper" tests="1" failures="${ok ? 0 : 1}" errors="0"><testcase classname="sealwrapper" name="${escapeXml(command)}">${failure}${body}</testcase></testsuite>\n`;
}

