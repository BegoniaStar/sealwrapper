import type { DiagnosticReporter } from './types';

export interface TextNode {
  kind: 'text';
  value: string;
}

export interface CommandNode {
  kind: 'command';
  name: string;
  parameters: readonly string[];
  position: number;
}

export type LightScriptNode = CommandNode | TextNode;

const commandNames = [
  '设置变量针对个人',
  '设置变量有效期',
  '距离上次激活时长',
  '设置变量针对群',
  '详细骰点计算',
  '正则匹配到的',
  '设置固态变量',
  '执行变量',
  '赋值变量',
  '骰点计算',
  '发送者QQ',
  '当前群号',
  '最后激活时间',
  '10位时间戳',
  '分割随取',
  '插入一行',
  '取出一行',
  '执行脚本',
  '现行日期',
  '随机数',
  '读项目',
  '到整数',
  '设置变量',
  '变量',
  '常量',
  '计算',
  '一天',
  '隐藏',
  '分隔',
  '换行',
  '艾特',
  '随取',
  '比较',
  '判断',
  '判空',
  '返回',
  '块',
] as const;

function splitParameters(value: string): readonly string[] {
  const values: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';
    if (character === '【') depth += 1;
    if (character === '】') depth -= 1;
    if (character === ',' && depth === 0) {
      values.push(value.slice(start, index));
      start = index + 1;
    }
  }
  values.push(value.slice(start));
  return values;
}

function commandName(value: string): string | null {
  for (const name of commandNames) {
    if (value.startsWith(name)) return name;
  }
  return null;
}

function normaliseHistoricalCommand(
  name: string,
  parameters: readonly string[],
): CommandNode {
  if (name !== '设置变量')
    return { kind: 'command', name, parameters, position: 0 };
  const parameter = parameters.join(',').trim();
  if (parameter.startsWith('针对个人')) {
    return {
      kind: 'command',
      name: '设置变量针对个人',
      parameters: [parameter.slice('针对个人'.length)],
      position: 0,
    };
  }
  if (parameter.startsWith('针对群')) {
    return {
      kind: 'command',
      name: '设置变量针对群',
      parameters: [parameter.slice('针对群'.length)],
      position: 0,
    };
  }
  return { kind: 'command', name, parameters, position: 0 };
}

function commandFromInner(inner: string, position: number): CommandNode | null {
  const name = commandName(inner);
  if (name === null) return null;
  const rawParameters = inner.slice(name.length);
  const normalised = normaliseHistoricalCommand(
    name,
    splitParameters(rawParameters),
  );
  return { ...normalised, position };
}

function unmatched(
  reporter: DiagnosticReporter,
  position: number,
  message: string,
): void {
  reporter.report({
    code: 'unbalanced-brackets',
    message: `${message} at character ${String(position + 1)}`,
    severity: 'error',
  });
}

/** Parses nested LightScript brackets without relying on a regular expression. */
export function parseLightScript(
  source: string,
  reporter: DiagnosticReporter,
): readonly LightScriptNode[] {
  const nodes: LightScriptNode[] = [];
  let textStart = 0;
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? '';
    if (character === '】') {
      unmatched(reporter, index, 'Unexpected closing bracket');
      index += 1;
      continue;
    }
    if (character !== '【') {
      index += 1;
      continue;
    }

    let depth = 1;
    let end = index + 1;
    while (end < source.length && depth > 0) {
      const candidate = source[end] ?? '';
      if (candidate === '【') depth += 1;
      if (candidate === '】') depth -= 1;
      end += 1;
    }
    if (depth !== 0) {
      unmatched(reporter, index, 'Unclosed opening bracket');
      if (textStart < source.length)
        nodes.push({ kind: 'text', value: source.slice(textStart) });
      return nodes;
    }

    const command = commandFromInner(source.slice(index + 1, end - 1), index);
    if (command === null) {
      if (textStart < end)
        nodes.push({ kind: 'text', value: source.slice(textStart, end) });
      index = end;
      textStart = end;
      continue;
    }
    if (textStart < index)
      nodes.push({ kind: 'text', value: source.slice(textStart, index) });
    nodes.push(command);
    index = end;
    textStart = end;
  }
  if (textStart < source.length)
    nodes.push({ kind: 'text', value: source.slice(textStart) });
  return nodes;
}
