import { calculate, formatNumber, rollDice } from './dices';
import { describeError } from './diagnostics';
import type {
  DiagnosticReporter,
  LightScriptAuto,
  LightScriptDocument,
  LightScriptHost,
} from './types';
import type { VariableAddress, VariableService } from './variables';

export interface LibEnvironment {
  address: VariableAddress;
  auto: LightScriptAuto;
  document: LightScriptDocument;
  host: LightScriptHost;
  reporter: DiagnosticReporter;
  variables: VariableService;
}

interface ScriptScope {
  Lib: Record<string, unknown>;
  [name: string]: unknown;
}

type ScriptEvaluator = (scope: ScriptScope, source: string) => unknown;

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value))
    return formatNumber(value);
  if (typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function userFacingIdentifier(environment: LibEnvironment): string {
  return environment.address.senderId;
}

function currentJrrp(environment: LibEnvironment): number {
  try {
    const [value, exists] = seal.vars.intGet(
      environment.host.context,
      '$t人品',
    );
    if (exists) return value;
  } catch (error) {
    environment.reporter.report({
      code: 'jrrp-int-get-failed',
      message: describeError(error),
      packageId: environment.document.id,
      severity: 'warning',
    });
  }
  try {
    const value = Number(seal.format(environment.host.context, '{$t人品}'));
    if (Number.isFinite(value)) return Math.trunc(value);
  } catch (error) {
    environment.reporter.report({
      code: 'jrrp-format-fallback-failed',
      message: describeError(error),
      packageId: environment.document.id,
      severity: 'warning',
    });
  }
  return 0;
}

function documentValue(
  document: LightScriptDocument,
  auto: LightScriptAuto,
  key: string,
): string {
  const autoValue = auto.fields[key];
  if (typeof autoValue === 'string') return autoValue;
  const documentValue = document.root[key];
  return typeof documentValue === 'string' ? documentValue : '';
}

function recordUnsupported(
  environment: LibEnvironment,
  name: 'sleep' | 'wget',
): void {
  environment.reporter.report({
    code: `unsupported-lib-${name}`,
    message: `Lib.${name} is unavailable in the SealDice 1.6.0 public JS API`,
    packageId: environment.document.id,
    severity: 'warning',
  });
}

function readMiddle(value: string, left: string, right: string): string {
  const start = value.indexOf(left);
  if (start === -1) return '';
  const offset = start + left.length;
  const end = value.indexOf(right, offset);
  return end === -1 ? '' : value.slice(offset, end);
}

function targetIsCurrentGroup(
  environment: LibEnvironment,
  group: string,
): boolean {
  return group === environment.address.groupId;
}

function targetIsCurrentSender(
  environment: LibEnvironment,
  user: string,
): boolean {
  return user === userFacingIdentifier(environment);
}

function recordUnsupportedTarget(
  environment: LibEnvironment,
  operation: string,
): void {
  environment.reporter.report({
    code: 'unsupported-lib-target',
    message: `${operation} can only reply to the current message with public SealDice APIs`,
    packageId: environment.document.id,
    severity: 'warning',
  });
}

function makeLib(environment: LibEnvironment): Record<string, unknown> {
  return {
    draw: (name: unknown): string => {
      try {
        const result = seal.deck.draw(
          environment.host.context,
          stringValue(name),
          true,
        );
        if (!result.exists) {
          environment.reporter.report({
            code: 'deck-draw-failed',
            message: result.err || `Deck does not exist: ${stringValue(name)}`,
            packageId: environment.document.id,
            severity: 'warning',
          });
          return '';
        }
        return result.result;
      } catch (error) {
        environment.reporter.report({
          code: 'deck-draw-failed',
          message: describeError(error),
          packageId: environment.document.id,
          severity: 'warning',
        });
        return '';
      }
    },
    getConfig: (name: unknown): string =>
      documentValue(environment.document, environment.auto, stringValue(name)),
    getConstant: (name: unknown): string =>
      environment.document.defines[stringValue(name)] ?? '',
    getGroup: (): string => environment.address.groupId,
    getSender: (): string => userFacingIdentifier(environment),
    getStringMiddle: (value: unknown, left: unknown, right: unknown): string =>
      readMiddle(stringValue(value), stringValue(left), stringValue(right)),
    getValue: (name: unknown): string =>
      environment.variables.get(stringValue(name), environment.address),
    groupChat: (): boolean => environment.address.groupId !== '',
    jrrp: (salt: unknown): number => {
      void salt;
      return currentJrrp(environment);
    },
    reply: (message: unknown): void => {
      environment.host.reply(stringValue(message));
    },
    roll: (expression: unknown): string => {
      const result = rollDice(stringValue(expression), () =>
        environment.host.random(),
      );
      if (result === null) {
        environment.reporter.report({
          code: 'unsupported-dice-expression',
          message: `Unsupported dice expression: ${stringValue(expression)}`,
          packageId: environment.document.id,
          severity: 'warning',
        });
        return '';
      }
      return formatNumber(result.value);
    },
    rollDetail: (expression: unknown): string => {
      const result = rollDice(stringValue(expression), () =>
        environment.host.random(),
      );
      if (result === null) {
        environment.reporter.report({
          code: 'unsupported-dice-expression',
          message: `Unsupported dice expression: ${stringValue(expression)}`,
          packageId: environment.document.id,
          severity: 'warning',
        });
        return '';
      }
      return `${result.detail}=${formatNumber(result.value)}`;
    },
    sender: userFacingIdentifier(environment),
    sendFriendPrivateMessage: (message: unknown, user: unknown): void => {
      if (!targetIsCurrentSender(environment, stringValue(user))) {
        recordUnsupportedTarget(environment, 'Lib.sendFriendPrivateMessage');
        return;
      }
      environment.host.reply(stringValue(message));
    },
    sendGroupMessage: (message: unknown, group: unknown): void => {
      if (!targetIsCurrentGroup(environment, stringValue(group))) {
        recordUnsupportedTarget(environment, 'Lib.sendGroupMessage');
        return;
      }
      environment.host.reply(stringValue(message));
    },
    sendPrivateMessage: (
      message: unknown,
      group: unknown,
      user: unknown,
    ): void => {
      if (
        !targetIsCurrentGroup(environment, stringValue(group)) ||
        !targetIsCurrentSender(environment, stringValue(user))
      ) {
        recordUnsupportedTarget(environment, 'Lib.sendPrivateMessage');
        return;
      }
      environment.host.reply(stringValue(message));
    },
    setAsSolidValue: (name: unknown): void => {
      environment.variables.setSolid(stringValue(name));
    },
    setTag: (name: unknown, tag: unknown): void => {
      const value = stringValue(tag);
      if (value.startsWith('person_')) {
        environment.variables.setScope(
          stringValue(name),
          'person',
          environment.address,
        );
      } else if (value.startsWith('group_')) {
        environment.variables.setScope(
          stringValue(name),
          'group',
          environment.address,
        );
      } else {
        environment.variables.setScope(
          stringValue(name),
          'global',
          environment.address,
        );
      }
    },
    setValue: (name: unknown, value: unknown): void => {
      environment.variables.set(
        stringValue(name),
        stringValue(value),
        environment.address,
      );
    },
    sleep: (milliseconds: unknown): void => {
      void milliseconds;
      recordUnsupported(environment, 'sleep');
    },
    wget: (url: unknown): string => {
      void url;
      recordUnsupported(environment, 'wget');
      return '';
    },
  };
}

function makeScope(
  lib: Record<string, unknown>,
  parameters: readonly string[],
): ScriptScope {
  const scope: ScriptScope = {
    Function: undefined,
    Lib: lib,
    console: undefined,
    global: undefined,
    globalThis: undefined,
    process: undefined,
    require: undefined,
    seal: undefined,
    window: undefined,
  };
  parameters.forEach((parameter, index) => {
    scope[`v${String(index)}`] = parameter;
  });
  return scope;
}

function sandboxedEvaluator(): ScriptEvaluator {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- local TOML JavaScript is an explicit compatibility feature.
  return Function(
    'scope',
    'source',
    'with (scope) { return eval(source); }',
  ) as ScriptEvaluator;
}

/** Executes trusted local pack JavaScript with only the LightScript scope bound. */
export function executeScript(
  script: string,
  parameters: readonly string[],
  environment: LibEnvironment,
): string {
  try {
    const value = sandboxedEvaluator()(
      makeScope(makeLib(environment), parameters),
      script,
    );
    return stringValue(value);
  } catch (error) {
    environment.reporter.report({
      code: 'js-error',
      message: describeError(error),
      packageId: environment.document.id,
      severity: 'error',
    });
    return `[JS_ERROR]${describeError(error)}`;
  }
}

export function calculateScriptNumber(value: string): string {
  const result = calculate(value);
  return result === null ? '0' : formatNumber(result);
}

export function getJrrp(environment: LibEnvironment): number {
  return currentJrrp(environment);
}
