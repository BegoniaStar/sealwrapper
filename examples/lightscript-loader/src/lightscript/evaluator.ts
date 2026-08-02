import { calculate, formatNumber, rollDice } from './dices';
import { describeError } from './diagnostics';
import { executeScript } from './lib';
import { parseLightScript, type CommandNode } from './parser';
import type {
  DiagnosticReporter,
  EvaluationResult,
  LightScriptAuto,
  LightScriptDocument,
  LightScriptHost,
  LightScriptStackFrame,
  TomlValue,
} from './types';
import type { VariableAddress, VariableService } from './variables';

export interface EvaluationEnvironment {
  address: VariableAddress;
  auto: LightScriptAuto;
  captures: readonly string[];
  document: LightScriptDocument;
  host: LightScriptHost;
  lastActivatedAt: number;
  reporter: DiagnosticReporter;
  variables: VariableService;
}

class ReturnSignal extends Error {
  public constructor(public readonly value: string) {
    super('LightScript return');
  }
}

function numeric(value: string): number {
  const result = Number(value.trim());
  return Number.isFinite(result) ? result : 0;
}

function normaliseArgument(value: string): string {
  if (/\d*\s*d\s*\d+/iu.test(value)) return value;
  const calculated = calculate(value.trim());
  return calculated === null ? value : formatNumber(calculated);
}

function restoreEscapes(value: string): string {
  return value
    .replace(/#zzk/gu, '【')
    .replace(/#yzk/gu, '】')
    .replace(/#ywdh/gu, ',');
}

function valueOfProject(
  document: LightScriptDocument,
  auto: LightScriptAuto,
  name: string,
): string {
  const autoValue = auto.fields[name];
  if (typeof autoValue === 'string') return autoValue;
  const rootValue = document.root[name];
  return typeof rootValue === 'string' ? rootValue : '';
}

function asString(value: TomlValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function currentDate(now: number, type: string): string {
  const date = new Date(now);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1);
  const day = String(date.getDate());
  if (type === '') return `${year}_${month}_${day}`;
  switch (type.slice(1)) {
    case '年':
      return year;
    case '月':
      return month;
    case '日':
      return day;
    case '星期':
      return `周${['日', '一', '二', '三', '四', '五', '六'][date.getDay()] ?? ''}`;
    default:
      return '';
  }
}

function randomInteger(
  minimum: number,
  maximum: number,
  random: () => number,
): number {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return 0;
  const low = Math.trunc(minimum);
  const high = Math.trunc(maximum);
  if (high < low) return 0;
  const bounded = Math.min(0.999_999_999, Math.max(0, random()));
  return Math.floor(bounded * (high - low + 1)) + low;
}

export class LightScriptEvaluator {
  private depth = 0;

  public constructor(private readonly environment: EvaluationEnvironment) {}

  private evaluateSource(
    source: string,
    stack: readonly LightScriptStackFrame[],
  ): string {
    if (this.depth >= 256)
      throw new Error('LightScript recursion limit exceeded');
    this.depth += 1;
    try {
      const nodes = parseLightScript(source.trim(), this.environment.reporter);
      let output = '';
      for (const node of nodes) {
        if (node.kind === 'text') {
          output += node.value;
          continue;
        }
        const frame: LightScriptStackFrame = {
          command: node.name,
          parameters: node.parameters.join(','),
        };
        output += this.evaluateCommand(node, [...stack, frame]);
      }
      return output.trim();
    } finally {
      this.depth -= 1;
    }
  }

  private evaluateParameter(
    value: string,
    stack: readonly LightScriptStackFrame[],
  ): string {
    return normaliseArgument(this.evaluateSource(value, stack));
  }

  private evaluateParameters(
    values: readonly string[],
    stack: readonly LightScriptStackFrame[],
  ): readonly string[] {
    return values.map((value) => this.evaluateParameter(value, stack));
  }

  private parameter(command: CommandNode, index: number): string {
    return command.parameters[index] ?? '';
  }

  private variableAddress(): VariableAddress {
    return this.environment.address;
  }

  private warn(
    code: string,
    message: string,
    stack: readonly LightScriptStackFrame[],
  ): void {
    this.environment.reporter.report({
      code,
      file: this.environment.document.file,
      message,
      packageId: this.environment.document.id,
      severity: 'warning',
      stack,
    });
  }

  private evaluateCommand(
    command: CommandNode,
    stack: readonly LightScriptStackFrame[],
  ): string {
    const value = (index: number): string =>
      this.evaluateParameter(this.parameter(command, index), stack);
    const values = (): readonly string[] =>
      this.evaluateParameters(command.parameters, stack);
    const address = this.variableAddress();

    switch (command.name) {
      case '返回': {
        const parameters = values();
        throw new ReturnSignal(parameters[0] ?? '');
      }
      case '块':
        return this.evaluateSource(this.parameter(command, 0), stack);
      case '隐藏':
        values();
        return '';
      case '换行':
      case '分隔':
        return '\n';
      case '艾特':
        return ' @艾特你 ';
      case '一天':
        return '86400';
      case '变量':
        return this.environment.variables.get(value(0), address);
      case '常量': {
        const name = value(0);
        const constant = this.environment.document.defines[name];
        if (constant !== undefined) return constant;
        this.warn('missing-constant', `Unknown constant: ${name}`, stack);
        return '';
      }
      case '赋值变量': {
        const parameters = values();
        this.environment.variables.set(
          parameters[0] ?? '',
          parameters[1] ?? '',
          address,
        );
        return '';
      }
      case '执行变量': {
        const code = this.environment.variables.get(value(0), address);
        return this.evaluateSource(code, stack);
      }
      case '计算': {
        const result = calculate(
          this.evaluateSource(this.parameter(command, 0), stack),
        );
        return result === null ? '0' : formatNumber(result);
      }
      case '到整数': {
        const result = Number(
          this.evaluateSource(this.parameter(command, 0), stack),
        );
        return Number.isFinite(result) ? String(Math.trunc(result)) : '0';
      }
      case '随机数': {
        if (command.parameters.length === 1) {
          const [minimum = '', maximum = ''] = this.parameter(command, 0)
            .trim()
            .split('-', 2);
          return String(
            randomInteger(numeric(minimum), numeric(maximum), () =>
              this.environment.host.random(),
            ),
          );
        }
        const parameters = values();
        return String(
          randomInteger(
            numeric(parameters[0] ?? ''),
            numeric(parameters[1] ?? ''),
            () => this.environment.host.random(),
          ),
        );
      }
      case '随取': {
        if (command.parameters.length === 0) return '';
        const index = randomInteger(0, command.parameters.length - 1, () =>
          this.environment.host.random(),
        );
        return this.evaluateSource(command.parameters[index] ?? '', stack);
      }
      case '分割随取': {
        const parameters = values();
        const split = (parameters[1] ?? '').split(parameters[0] ?? '');
        return (
          split[
            randomInteger(0, Math.max(0, split.length - 1), () =>
              this.environment.host.random(),
            )
          ] ?? ''
        );
      }
      case '比较': {
        const left = numeric(
          this.evaluateSource(this.parameter(command, 0), stack),
        );
        const right = numeric(
          this.evaluateSource(this.parameter(command, 1), stack),
        );
        return this.evaluateSource(
          this.parameter(command, left >= right ? 2 : 3),
          stack,
        );
      }
      case '判断': {
        const left = this.evaluateSource(this.parameter(command, 0), stack);
        const right = this.evaluateSource(this.parameter(command, 1), stack);
        return this.evaluateSource(
          this.parameter(command, left !== right ? 2 : 3),
          stack,
        );
      }
      case '判空': {
        const current = this.evaluateSource(this.parameter(command, 0), stack);
        return current === ''
          ? this.evaluateSource(this.parameter(command, 1), stack)
          : this.evaluateSource(current, stack);
      }
      case '读项目':
        return valueOfProject(
          this.environment.document,
          this.environment.auto,
          value(0),
        );
      case '发送者QQ':
        return this.environment.address.senderId;
      case '当前群号':
        return this.environment.address.groupId;
      case '现行日期':
        return currentDate(this.environment.host.now(), value(0));
      case '10位时间戳':
        return String(Math.floor(this.environment.host.now() / 1_000));
      case '正则匹配到的': {
        const index = Math.trunc(numeric(value(0)));
        return this.environment.captures[index] ?? '';
      }
      case '设置固态变量':
        this.environment.variables.setSolid(value(0));
        return '';
      case '设置变量针对个人':
        this.environment.variables.setScope(value(0), 'person', address);
        return '';
      case '设置变量针对群':
        this.environment.variables.setScope(value(0), 'group', address);
        return '';
      case '设置变量有效期': {
        if (command.parameters.length < 2) {
          this.warn(
            'invalid-variable-expiry',
            '设置变量有效期 requires (变量名, 秒数); no variable was changed',
            stack,
          );
          return '';
        }
        const parameters = values();
        this.environment.variables.setExpiry(
          parameters[0] ?? '',
          numeric(parameters[1] ?? ''),
          address,
        );
        return '';
      }
      case '骰点计算': {
        const expression = value(0);
        const roll = rollDice(expression, () => this.environment.host.random());
        if (roll === null) {
          this.warn(
            'unsupported-dice-expression',
            `Unsupported dice expression: ${expression}`,
            stack,
          );
          return '';
        }
        return formatNumber(roll.value);
      }
      case '详细骰点计算': {
        const expression = value(0);
        const roll = rollDice(expression, () => this.environment.host.random());
        if (roll === null) {
          this.warn(
            'unsupported-dice-expression',
            `Unsupported dice expression: ${expression}`,
            stack,
          );
          return '';
        }
        return `${roll.detail}=${formatNumber(roll.value)}`;
      }
      case '执行脚本': {
        const parameters = values();
        return executeScript(parameters[0] ?? '', parameters, this.environment);
      }
      case '设置变量':
        this.warn(
          'unsupported-historical-command',
          '设置变量 requires 针对个人 or 针对群',
          stack,
        );
        return '';
      case '最后激活时间':
        return String(Math.floor(this.environment.lastActivatedAt / 1_000));
      case '距离上次激活时长':
        return String(
          Math.floor(
            (this.environment.host.now() - this.environment.lastActivatedAt) /
              1_000,
          ),
        );
      case '插入一行':
      case '取出一行':
        this.warn(
          'unavailable-command-context',
          `${command.name} is handled by the document runtime, not this evaluator`,
          stack,
        );
        return '';
      default:
        this.warn('unknown-command', `Unknown command: ${command.name}`, stack);
        return '';
    }
  }

  public run(): EvaluationResult {
    try {
      return {
        output: restoreEscapes(
          this.evaluateSource(this.environment.auto.program ?? '', []),
        ),
        returned: false,
      };
    } catch (error) {
      if (error instanceof ReturnSignal)
        return { output: restoreEscapes(error.value), returned: true };
      this.environment.reporter.report({
        code: 'execution-error',
        file: this.environment.document.file,
        message: describeError(error),
        packageId: this.environment.document.id,
        severity: 'error',
      });
      return {
        error: describeError(error),
        output: '无法执行！',
        returned: false,
      };
    }
  }
}

export function outputFromContent(auto: LightScriptAuto): string {
  return restoreEscapes(asString(auto.content));
}
