import type {
  DiagnosticReporter,
  ParsedTomlDocument,
  RawTomlTable,
  TomlScalar,
  TomlValue,
} from './types';

interface Cursor {
  index: number;
  source: string;
}

interface TomlParseOptions {
  file: string;
  reporter: DiagnosticReporter;
}

function isWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\r';
}

function lineAndColumn(source: string, index: number): string {
  const before = source.slice(0, index);
  const line = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n');
  const column = index - lineStart;
  return `${String(line)}:${String(column)}`;
}

function fail(
  cursor: Cursor,
  options: TomlParseOptions,
  message: string,
): never {
  options.reporter.report({
    code: 'toml-parse-error',
    file: options.file,
    message: `${message} at ${lineAndColumn(cursor.source, cursor.index)}`,
    severity: 'error',
  });
  throw new Error(message);
}

function skipSpaceAndComments(cursor: Cursor): void {
  while (cursor.index < cursor.source.length) {
    const character = cursor.source[cursor.index] ?? '';
    if (isWhitespace(character) || character === '\n') {
      cursor.index += 1;
      continue;
    }
    if (character === '#') {
      while (
        cursor.index < cursor.source.length &&
        cursor.source[cursor.index] !== '\n'
      ) {
        cursor.index += 1;
      }
      continue;
    }
    return;
  }
}

function skipInlineSpace(cursor: Cursor): void {
  while (isWhitespace(cursor.source[cursor.index] ?? '')) cursor.index += 1;
}

function consumeLineEnd(cursor: Cursor, options: TomlParseOptions): void {
  skipInlineSpace(cursor);
  const character = cursor.source[cursor.index];
  if (character === '#') {
    while (
      cursor.index < cursor.source.length &&
      cursor.source[cursor.index] !== '\n'
    ) {
      cursor.index += 1;
    }
  }
  if (cursor.source[cursor.index] === '\n') {
    cursor.index += 1;
    return;
  }
  if (cursor.index < cursor.source.length)
    fail(cursor, options, 'Expected end of line');
}

function parseBasicString(cursor: Cursor, options: TomlParseOptions): string {
  if (cursor.source.slice(cursor.index, cursor.index + 3) === '"""') {
    cursor.index += 3;
    if (cursor.source[cursor.index] === '\r') cursor.index += 1;
    if (cursor.source[cursor.index] === '\n') cursor.index += 1;
    let value = '';
    while (cursor.index < cursor.source.length) {
      if (cursor.source.slice(cursor.index, cursor.index + 3) === '"""') {
        cursor.index += 3;
        return decodeBasicEscapes(value, cursor, options);
      }
      value += cursor.source[cursor.index] ?? '';
      cursor.index += 1;
    }
    return fail(cursor, options, 'Unterminated multiline string');
  }

  const openingQuote = cursor.index;
  cursor.index += 1;
  let value = '';
  let escaped = false;
  while (cursor.index < cursor.source.length) {
    const character = cursor.source[cursor.index] ?? '';
    cursor.index += 1;
    if (escaped) {
      value += `\\${character}`;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') return decodeBasicEscapes(value, cursor, options);
    if (character === '\n' && value === '')
      return parseLegacyMultilineBasicString(cursor, options, openingQuote);
    if (character === '\n')
      return fail(cursor, options, 'Newline in basic string');
    value += character;
  }
  return fail(cursor, options, 'Unterminated string');
}

/**
 * Historical 回雪 packs use a non-standard multiline form: `key="` on one
 * line and a lone `"` on a later line. Accept that legacy spelling only when
 * the opening quote is immediately followed by a newline, so malformed normal
 * TOML strings remain errors.
 */
function parseLegacyMultilineBasicString(
  cursor: Cursor,
  options: TomlParseOptions,
  openingQuote: number,
): string {
  options.reporter.report({
    code: 'legacy-toml-syntax',
    file: options.file,
    message: `Accepted legacy single-quote multiline string at ${lineAndColumn(
      cursor.source,
      openingQuote,
    )}`,
    severity: 'warning',
  });
  const contentStart = cursor.index;
  let lineStart = cursor.index;
  while (lineStart <= cursor.source.length) {
    const nextLine = cursor.source.indexOf('\n', lineStart);
    const lineEnd = nextLine === -1 ? cursor.source.length : nextLine;
    const line = cursor.source.slice(lineStart, lineEnd);
    if (/^[ \t\r]*"[ \t\r]*$/u.test(line)) {
      const quote = lineStart + line.indexOf('"');
      const value = cursor.source.slice(contentStart, lineStart);
      cursor.index = quote + 1;
      return decodeBasicEscapes(value, cursor, options);
    }
    if (nextLine === -1) break;
    lineStart = nextLine + 1;
  }
  return fail(cursor, options, 'Unterminated legacy multiline string');
}

function decodeBasicEscapes(
  value: string,
  cursor: Cursor,
  options: TomlParseOptions,
): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';
    if (character !== '\\') {
      result += character;
      continue;
    }
    const escaped = value[index + 1];
    index += 1;
    switch (escaped) {
      case 'b':
        result += '\b';
        break;
      case 'f':
        result += '\f';
        break;
      case 'n':
        result += '\n';
        break;
      case 'r':
        result += '\r';
        break;
      case 't':
        result += '\t';
        break;
      case '"':
        result += '"';
        break;
      case '\\':
        result += '\\';
        break;
      case undefined:
        return fail(cursor, options, 'Unterminated string escape');
      default:
        cursor.index -= 1;
        return fail(cursor, options, `Unsupported string escape \\${escaped}`);
    }
  }
  return result;
}

function parseLiteralString(cursor: Cursor, options: TomlParseOptions): string {
  if (cursor.source.slice(cursor.index, cursor.index + 3) === "'''") {
    cursor.index += 3;
    const end = cursor.source.indexOf("'''", cursor.index);
    if (end === -1)
      return fail(cursor, options, 'Unterminated multiline literal');
    const value = cursor.source.slice(cursor.index, end);
    cursor.index = end + 3;
    return value.startsWith('\n') ? value.slice(1) : value;
  }
  cursor.index += 1;
  const end = cursor.source.indexOf("'", cursor.index);
  if (end === -1) return fail(cursor, options, 'Unterminated literal string');
  const value = cursor.source.slice(cursor.index, end);
  cursor.index = end + 1;
  return value;
}

function parseBareValue(cursor: Cursor): TomlScalar {
  const start = cursor.index;
  while (cursor.index < cursor.source.length) {
    const character = cursor.source[cursor.index] ?? '';
    if (character === '#' || character === '\n' || isWhitespace(character))
      break;
    cursor.index += 1;
  }
  const raw = cursor.source.slice(start, cursor.index);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const number = Number(raw);
  return Number.isFinite(number) && raw !== '' ? number : raw;
}

function parseArray(
  cursor: Cursor,
  options: TomlParseOptions,
): readonly string[] {
  cursor.index += 1;
  const values: string[] = [];
  while (cursor.index < cursor.source.length) {
    skipSpaceAndComments(cursor);
    if (cursor.source[cursor.index] === ']') {
      cursor.index += 1;
      return values;
    }
    const value = parseValue(cursor, options);
    if (typeof value !== 'string')
      return fail(cursor, options, 'Only string arrays are supported');
    values.push(value);
    skipSpaceAndComments(cursor);
    const character = cursor.source[cursor.index];
    if (character === ',') {
      cursor.index += 1;
      continue;
    }
    if (character === ']') {
      cursor.index += 1;
      return values;
    }
    return fail(cursor, options, 'Expected comma or closing bracket in array');
  }
  return fail(cursor, options, 'Unterminated array');
}

function parseValue(cursor: Cursor, options: TomlParseOptions): TomlValue {
  const character = cursor.source[cursor.index];
  if (character === '"') return parseBasicString(cursor, options);
  if (character === "'") return parseLiteralString(cursor, options);
  if (character === '[') return parseArray(cursor, options);
  return parseBareValue(cursor);
}

function parseKey(cursor: Cursor, options: TomlParseOptions): string {
  const start = cursor.index;
  while (cursor.index < cursor.source.length) {
    const character = cursor.source[cursor.index] ?? '';
    if (character === '=' || isWhitespace(character)) break;
    if (character === '\n' || character === '#')
      return fail(cursor, options, 'Expected assignment key');
    cursor.index += 1;
  }
  const key = cursor.source.slice(start, cursor.index);
  if (!key) return fail(cursor, options, 'Expected assignment key');
  return key;
}

function parseTableName(cursor: Cursor, options: TomlParseOptions): string {
  const arrayTable =
    cursor.source.slice(cursor.index, cursor.index + 2) === '[[';
  cursor.index += arrayTable ? 2 : 1;
  const close = arrayTable ? ']]' : ']';
  const end = cursor.source.indexOf(close, cursor.index);
  if (end === -1) return fail(cursor, options, 'Unterminated table header');
  const name = cursor.source.slice(cursor.index, end).trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(name))
    return fail(cursor, options, 'Unsupported table name');
  cursor.index = end + close.length;
  consumeLineEnd(cursor, options);
  return name;
}

function tableFields(
  root: Record<string, TomlValue>,
  table: RawTomlTable | null,
): Record<string, TomlValue> {
  return table === null ? root : table.fields;
}

/**
 * The compatibility layer deliberately implements the small TOML surface used
 * by historical LightScript packs. It keeps values as strings/arrays instead
 * of accepting arbitrary TOML values that LightScript cannot consume.
 */
export function parseToml(
  source: string,
  options: TomlParseOptions,
): ParsedTomlDocument | null {
  const cursor: Cursor = { index: 0, source };
  const root: Record<string, TomlValue> = {};
  const tables: RawTomlTable[] = [];
  let current: RawTomlTable | null = null;

  try {
    while (cursor.index < source.length) {
      skipSpaceAndComments(cursor);
      if (cursor.index >= source.length) break;
      if (source[cursor.index] === '[') {
        const arrayTable =
          source.slice(cursor.index, cursor.index + 2) === '[[';
        const name = parseTableName(cursor, options);
        if (arrayTable) {
          current = { fields: {}, name, ordinal: tables.length };
          tables.push(current);
        } else {
          current = { fields: {}, name, ordinal: tables.length };
          tables.push(current);
        }
        continue;
      }

      const key = parseKey(cursor, options);
      skipInlineSpace(cursor);
      if (source[cursor.index] !== '=')
        return fail(cursor, options, 'Expected equals sign');
      cursor.index += 1;
      skipInlineSpace(cursor);
      const value = parseValue(cursor, options);
      tableFields(root, current)[key] = value;
      consumeLineEnd(cursor, options);
    }
  } catch {
    return null;
  }

  return { root, tables };
}
