import { escapeXml } from './xml.ts';

export type OutputFormat = 'text' | 'json' | 'junit';

export type OutputTestCase = {
  classname: string;
  name: string;
  durationMilliseconds: number;
  failure?: string;
  output?: string;
};

export type OutputEnvelope = {
  format: 'sealwrapper.cli/v1';
  command: string;
  ok: boolean;
  messages: string[];
  error?: { message: string; exitCode?: number };
  tests?: OutputTestCase[];
};

export function parseOutputFormat(value: string | undefined): OutputFormat | undefined {
  if (value === undefined) return undefined;
  if (value === 'text' || value === 'json' || value === 'junit') return value;
  throw new Error(`Unsupported output format: ${value}; expected text, json, or junit`);
}

function cdata(value: string): string {
  return `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

function renderTestCase(testCase: OutputTestCase): string {
  const failure = testCase.failure === undefined ? '' : `<failure message="${escapeXml(testCase.failure)}">${cdata(testCase.failure)}</failure>`;
  const output = testCase.output === undefined ? '' : `<system-out>${cdata(testCase.output)}</system-out>`;
  return `<testcase classname="${escapeXml(testCase.classname)}" name="${escapeXml(testCase.name)}" time="${(testCase.durationMilliseconds / 1_000).toFixed(3)}">${failure}${output}</testcase>`;
}

export function renderOutput(format: OutputFormat, command: string, ok: boolean, messages: readonly string[], error?: { message: string; exitCode?: number }, testCases: readonly OutputTestCase[] = []): string {
  const cases = [...testCases];
  if (error && !cases.some((testCase) => testCase.failure !== undefined)) {
    cases.push({ classname: 'sealwrapper', name: command, durationMilliseconds: 0, failure: error.message });
  }
  if (cases.length === 0) cases.push({ classname: 'sealwrapper', name: command, durationMilliseconds: 0 });
  const envelope: OutputEnvelope = { format: 'sealwrapper.cli/v1', command, ok, messages: [...messages], ...(error ? { error } : {}), ...(testCases.length ? { tests: [...testCases] } : {}) };
  if (format === 'json') return `${JSON.stringify(envelope, null, 2)}\n`;
  const body = messages.length ? `<system-out>${cdata(messages.join('\n'))}</system-out>` : '';
  const failures = cases.filter((testCase) => testCase.failure !== undefined).length;
  return `<testsuite name="sealwrapper" tests="${cases.length}" failures="${failures}" errors="0">${cases.map(renderTestCase).join('')}${body}</testsuite>\n`;
}
