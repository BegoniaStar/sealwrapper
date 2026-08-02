import { invariant, SealwrapperError } from './errors.ts';

function object(value: unknown, label: string): Record<string, any> {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, any>;
}

function outputEvents(transcript: any): any[] {
  return Array.isArray(transcript?.messages) ? transcript.messages.filter((message: any) => message?.direction === 'out') : [];
}

function canonicalTimestamp(value: unknown, label: string): string {
  invariant(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value)), `${label} must be an ISO-8601 timestamp`);
  return new Date(value).toISOString();
}

function scalarVariables(value: unknown, label: string): void {
  const variables = object(value, label);
  for (const [key, item] of Object.entries(variables)) {
    invariant(typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)), `${label}.${key} must be a string, number, or boolean`);
  }
}

function host(value: unknown): Record<string, any> {
  const raw = structuredClone(object(value, 'scenario.host'));
  for (const key of Object.keys(raw)) invariant(['diceMasters', 'extensionConfigs'].includes(key), `scenario.host.${key} is unsupported`);
  const result: Record<string, any> = { diceMasters: [], extensionConfigs: {} };
  if (raw.diceMasters !== undefined) {
    invariant(Array.isArray(raw.diceMasters), 'scenario.host.diceMasters must be an array');
    const masters = raw.diceMasters.map((entry: unknown, index: number) => {
      invariant(typeof entry === 'string' && /^(?:QQ:)?\d+$/.test(entry), `scenario.host.diceMasters[${index}] must be a numeric QQ ID or QQ:<id>`);
      return entry.startsWith('QQ:') ? entry : `QQ:${entry}`;
    });
    result.diceMasters = [...new Set(masters)].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
  }
  if (raw.extensionConfigs !== undefined) {
    const configs = object(raw.extensionConfigs, 'scenario.host.extensionConfigs');
    for (const [extension, values] of Object.entries(configs)) {
      invariant(extension.length > 0 && !extension.includes('\0'), `scenario.host.extensionConfigs.${extension} must use a non-empty extension ID`);
      scalarVariables(values, `scenario.host.extensionConfigs.${extension}`);
      result.extensionConfigs[extension] = structuredClone(values);
    }
  }
  return result;
}

function messageSegments(value: unknown, label: string): any[] {
  invariant(Array.isArray(value), `${label} must be an array`);
  return value.map((raw, index) => {
    const segment = structuredClone(object(raw, `${label}[${index}]`));
    invariant(['text', 'at', 'image', 'face', 'reply', 'forward'].includes(segment.type), `${label}[${index}].type is unsupported`);
    if (segment.type === 'text') invariant(typeof segment.text === 'string', `${label}[${index}].text must be a string`);
    if (segment.type === 'at') invariant(typeof segment.target === 'string' && /^(?:\d+|all)$/.test(segment.target), `${label}[${index}].target must be a numeric QQ ID or all`);
    if (segment.type === 'face') invariant(typeof segment.id === 'string' || typeof segment.id === 'number', `${label}[${index}].id must be a string or number`);
    // Images and forwards are transcript payload only. The bridge deliberately
    // never resolves their URL/path, so scenarios cannot turn into I/O tests.
    if (segment.type === 'image' && segment.url !== undefined) invariant(typeof segment.url === 'string', `${label}[${index}].url must be a string`);
    return segment;
  });
}

function decodeCqParameter(value: string): string {
  // CQ's standard escaping is deliberately decoded only for the transport
  // fields below. It is never interpreted as a URL, file path, or command.
  return value.replaceAll('&#44;', ',').replaceAll('&#91;', '[').replaceAll('&#93;', ']').replaceAll('&amp;', '&');
}

function cqParameters(value: string): Record<string, string> {
  const parameters: Record<string, string> = {};
  for (const part of value.split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) continue;
    parameters[key] = decodeCqParameter(part.slice(separator + 1));
  }
  return parameters;
}

/**
 * Converts common inbound CQ text into the same inert segment vocabulary that
 * scenario JSON accepts. This models a QQ adapter's parsed message shape; it
 * intentionally does not call the core's string-CQ converter because that
 * converter may resolve image/file resources.
 */
function segmentsFromCqText(value: string): any[] | null {
  const expression = /\[CQ:([A-Za-z][A-Za-z0-9_-]*)(?:,([^\]]*))?\]/gu;
  const segments: any[] = [];
  let offset = 0;
  let recognized = false;
  for (const match of value.matchAll(expression)) {
    const index = match.index ?? 0;
    if (index > offset) segments.push({ type: 'text', text: value.slice(offset, index) });
    const type = match[1];
    const parameters = cqParameters(match[2] ?? '');
    if (type === 'at' && /^(?:\d+|all)$/.test(parameters.qq ?? '')) {
      segments.push({ type: 'at', target: parameters.qq });
      recognized = true;
    } else if (type === 'face' && typeof parameters.id === 'string' && parameters.id.length > 0) {
      segments.push({ type: 'face', id: parameters.id });
      recognized = true;
    } else if (type === 'image' && typeof (parameters.file ?? parameters.url) === 'string' && (parameters.file ?? parameters.url)!.length > 0) {
      segments.push({ type: 'image', url: parameters.file ?? parameters.url, alt: 'CQ 图片' });
      recognized = true;
    } else {
      // Preserve unsupported or malformed CQ literally rather than granting it
      // adapter semantics it does not have in this hermetic fake host.
      segments.push({ type: 'text', text: match[0] });
    }
    offset = index + match[0].length;
  }
  if (!recognized) return null;
  if (offset < value.length) segments.push({ type: 'text', text: value.slice(offset) });
  return segments;
}

function user(value: unknown, label: string): Record<string, any> {
  const result = structuredClone(object(value, label));
  if (result.nickname !== undefined) invariant(typeof result.nickname === 'string', `${label}.nickname must be a string`);
  if (result.role !== undefined) invariant(['owner', 'admin', 'member', 'bot'].includes(result.role), `${label}.role must be owner, admin, member, or bot`);
  if (result.variables !== undefined) scalarVariables(result.variables, `${label}.variables`);
  return result;
}

function diagnosticExpectation(value: unknown, label: string) {
  invariant(Array.isArray(value), `${label} must be an array`);
  for (const [index, item] of value.entries()) {
    const expected = object(item, `${label}[${index}]`);
    invariant(typeof expected.ruleId === 'string' && expected.ruleId.length > 0, `${label}[${index}].ruleId must be a non-empty string`);
    if (expected.severity !== undefined) invariant(['error', 'warning', 'note'].includes(expected.severity), `${label}[${index}].severity must be error, warning, or note`);
  }
}

function outputExpectation(value: unknown, label: string): void {
  const expected = object(value, label);
  if (expected.textPattern !== undefined) {
    invariant(typeof expected.textPattern === 'string' && expected.textPattern.length > 0, `${label}.textPattern must be a non-empty regular expression string`);
    invariant(expected.text === undefined, `${label} must use either text or textPattern, not both`);
    try { new RegExp(expected.textPattern, 'u'); } catch { throw new SealwrapperError(`${label}.textPattern is not a valid regular expression`, 2); }
  }
}

function replyAssertion(value: unknown, label: string): Record<string, any> {
  const assertion = object(value, label);
  invariant(Number.isInteger(assertion.inputSequence) && assertion.inputSequence > 0, `${label}.inputSequence must be a positive integer`);
  return assertion;
}

function advancedExpectations(expect: Record<string, any>) {
  if (expect.cooldown !== undefined) {
    const cooldown = replyAssertion(expect.cooldown, 'scenario.expect.cooldown');
    invariant(Number.isInteger(cooldown.outputs) && cooldown.outputs >= 0, 'scenario.expect.cooldown.outputs must be a non-negative integer');
  }
  if (expect.priority !== undefined) {
    const priority = replyAssertion(expect.priority, 'scenario.expect.priority');
    invariant(typeof priority.text === 'string', 'scenario.expect.priority.text must be a string');
  }
  if (expect.random !== undefined) {
    const random = replyAssertion(expect.random, 'scenario.expect.random');
    invariant(Array.isArray(random.oneOf) && random.oneOf.length > 0 && random.oneOf.every((item: unknown) => typeof item === 'string'), 'scenario.expect.random.oneOf must be a non-empty string array');
    if (random.repeatable !== undefined) invariant(typeof random.repeatable === 'boolean', 'scenario.expect.random.repeatable must be a boolean');
  }
}

function contains(actual: any, expected: any): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((value, index) => contains(actual[index], value));
  if (expected !== null && typeof expected === 'object') return actual !== null && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => contains(actual[key], value));
  return Object.is(actual, expected);
}

export function normalizeScenario(raw: unknown): any {
  const scenario = structuredClone(object(raw, 'scenario'));
  if (scenario.release !== undefined) invariant(typeof scenario.release === 'boolean', 'scenario.release must be a boolean');
  else scenario.release = false;
  invariant(Array.isArray(scenario.messages), 'scenario.messages must be an array');
  if (scenario.clock !== undefined) scenario.clock = canonicalTimestamp(scenario.clock, 'scenario.clock');
  else scenario.clock = '1970-01-01T00:00:00.000Z';
  if (scenario.seed !== undefined) invariant(Number.isInteger(scenario.seed) && scenario.seed >= 0 && scenario.seed <= 0x7fffffff, 'scenario.seed must be a non-negative 31-bit integer');
  else scenario.seed = 0;
  scenario.host = scenario.host === undefined ? { diceMasters: [], extensionConfigs: {} } : host(scenario.host);
  if (scenario.variables !== undefined) scalarVariables(scenario.variables, 'scenario.variables');
  if (scenario.users !== undefined) {
    const users = object(scenario.users, 'scenario.users');
    for (const [qq, entry] of Object.entries(users)) {
      invariant(/^\d+$/.test(qq), 'scenario.users keys must be numeric fake QQ IDs');
      users[qq] = user(entry, `scenario.users.${qq}`);
    }
  } else scenario.users = {};
  scenario.messages = scenario.messages.map((message: any, index: number) => {
    const rawMessage = object(message, `scenario.messages[${index}]`);
    if (rawMessage.sequence !== undefined) invariant(Number.isSafeInteger(rawMessage.sequence) && rawMessage.sequence > 0, `scenario.messages[${index}].sequence must be a positive safe integer`);
    const normalized: Record<string, any> = { ...rawMessage, sequence: rawMessage.sequence ?? index + 1 };
    if (normalized.qq !== undefined) invariant(typeof normalized.qq === 'string' && /^\d+$/.test(normalized.qq), `scenario.messages[${index}].qq must be a numeric fake QQ ID`);
    else normalized.qq = '10000';
    if (normalized.scope !== undefined) invariant(normalized.scope === 'group' || normalized.scope === 'private', `scenario.messages[${index}].scope must be group or private`);
    if (normalized.timestamp !== undefined) normalized.timestamp = canonicalTimestamp(normalized.timestamp, `scenario.messages[${index}].timestamp`);
    if (normalized.role !== undefined) invariant(['owner', 'admin', 'member', 'bot'].includes(normalized.role), `scenario.messages[${index}].role must be owner, admin, member, or bot`);
    if (normalized.user !== undefined) normalized.user = user(normalized.user, `scenario.messages[${index}].user`);
    else normalized.user = scenario.users[normalized.qq] ? structuredClone(scenario.users[normalized.qq]) : {};
    if (normalized.variables !== undefined) scalarVariables(normalized.variables, `scenario.messages[${index}].variables`);
    return normalized;
  });
  scenario.messages.sort((left: any, right: any) => left.sequence - right.sequence);
  const seen = new Set<number>();
  for (const message of scenario.messages) {
    invariant(Number.isInteger(message.sequence) && message.sequence > 0 && !seen.has(message.sequence), 'scenario message sequences must be unique positive integers');
    seen.add(message.sequence);
    if (message.segments !== undefined) message.segments = messageSegments(message.segments, `scenario.messages[${message.sequence}].segments`);
    else if (typeof message.text === 'string') {
      const parsed = segmentsFromCqText(message.text);
      if (parsed) message.segments = messageSegments(parsed, `scenario.messages[${message.sequence}].segments`);
    }
    if (message.text === undefined && Array.isArray(message.segments)) message.text = message.segments.filter((segment: any) => segment.type === 'text').map((segment: any) => segment.text).join('');
    invariant(typeof message.text === 'string', 'scenario message text must be a string unless text segments provide it');
    if (message.timestamp === undefined) {
      const timestamp = Date.parse(scenario.clock) + (message.sequence - 1) * 1000;
      invariant(Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15, `scenario.messages[${message.sequence}].timestamp is outside the representable date range`);
      message.timestamp = new Date(timestamp).toISOString();
    }
  }
  if (scenario.packages !== undefined) {
    invariant(Array.isArray(scenario.packages) && scenario.packages.every((item) => typeof item === 'string' && item.endsWith('.sealpack') && !item.includes('..') && !item.startsWith('/')), 'scenario.packages must contain archive-relative .sealpack paths');
    scenario.packages.sort((left: string, right: string) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
  }
  if (scenario.expect !== undefined) {
    const expect = object(scenario.expect, 'scenario.expect');
    if (expect.noOutput !== undefined) invariant(typeof expect.noOutput === 'boolean', 'scenario.expect.noOutput must be a boolean');
    if (expect.outputs !== undefined) {
      invariant(Array.isArray(expect.outputs), 'scenario.expect.outputs must be an array');
      for (const [index, output] of expect.outputs.entries()) outputExpectation(output, `scenario.expect.outputs[${index}]`);
    }
    if (expect.transcript !== undefined) object(expect.transcript, 'scenario.expect.transcript');
    if (expect.diagnostics !== undefined) diagnosticExpectation(expect.diagnostics, 'scenario.expect.diagnostics');
    advancedExpectations(expect);
  }
  return scenario;
}

export function matchTranscriptExpectation(transcript: any, expect: any, diagnostics: any[] = []): string | null {
  if (!expect) return null;
  const outputs = outputEvents(transcript);
  if (expect.noOutput === true && outputs.length > 0) return `expected no output, received ${outputs.length} output event(s)`;
  if (expect.outputs !== undefined) {
    if (!Array.isArray(expect.outputs)) return 'expect.outputs must be an array';
    if (outputs.length !== expect.outputs.length) return `outputs length ${outputs.length} does not equal expected ${expect.outputs.length}`;
    for (let index = 0; index < expect.outputs.length; index += 1) {
      const expected = structuredClone(expect.outputs[index]);
      const pattern = expected.textPattern;
      delete expected.textPattern;
      if (!contains(outputs[index], expected)) return `outputs[${index}] does not match expected subset`;
      if (pattern !== undefined && (typeof outputs[index]?.text !== 'string' || !new RegExp(pattern, 'u').test(outputs[index].text))) return `outputs[${index}] text does not match expected text pattern`;
    }
  }
  if (expect.transcript !== undefined && !contains(transcript, expect.transcript)) return 'transcript does not match expected subset';
  if (expect.diagnostics !== undefined) {
    if (!Array.isArray(expect.diagnostics)) return 'expect.diagnostics must be an array';
    if (diagnostics.length !== expect.diagnostics.length) return `diagnostics length ${diagnostics.length} does not equal expected ${expect.diagnostics.length}`;
    for (let index = 0; index < expect.diagnostics.length; index += 1) if (!contains(diagnostics[index], expect.diagnostics[index])) return `diagnostics[${index}] does not match expected subset`;
  }
  const outputFor = (inputSequence: number) => outputs.filter((event: any) => event.inReplyToSequence === inputSequence);
  if (expect.cooldown !== undefined) {
    const cooldown = expect.cooldown;
    if (outputFor(cooldown.inputSequence).length !== cooldown.outputs) return `cooldown for input ${cooldown.inputSequence} expected ${cooldown.outputs} output event(s)`;
  }
  if (expect.priority !== undefined) {
    const priority = expect.priority;
    const matching = outputFor(priority.inputSequence);
    if (matching.length === 0 || matching[0].text !== priority.text) return `priority for input ${priority.inputSequence} did not select expected first output`;
  }
  if (expect.random !== undefined) {
    const random = expect.random;
    const matching = outputFor(random.inputSequence);
    if (matching.length === 0 || !random.oneOf.includes(matching[0].text)) return `random output for input ${random.inputSequence} is outside declared choices`;
  }
  return null;
}

export function assertTranscriptExpectation(transcript: any, expect: any, diagnostics: any[] = []) {
  const mismatch = matchTranscriptExpectation(transcript, expect, diagnostics);
  if (mismatch) throw new SealwrapperError(`Scenario assertion failed: ${mismatch}`, 1);
}
