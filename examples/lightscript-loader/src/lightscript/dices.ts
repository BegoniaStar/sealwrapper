import type { DiceRoll } from './types';

interface NumberNode {
  kind: 'number';
  value: number;
}

interface DiceNode {
  count: number;
  kind: 'dice';
  sides: number;
}

interface UnaryNode {
  kind: 'unary';
  operator: '+' | '-';
  value: MathNode;
}

interface BinaryNode {
  kind: 'binary';
  left: MathNode;
  operator: '+' | '-' | '*' | '/';
  right: MathNode;
}

type MathNode = BinaryNode | DiceNode | NumberNode | UnaryNode;

interface ParserState {
  index: number;
  source: string;
}

function skipSpace(state: ParserState): void {
  while (/\s/u.test(state.source[state.index] ?? '')) state.index += 1;
}

function consume(state: ParserState, expected: string): boolean {
  skipSpace(state);
  if (state.source[state.index] !== expected) return false;
  state.index += 1;
  return true;
}

function parseNumberText(state: ParserState): string {
  skipSpace(state);
  const start = state.index;
  while (/\d/u.test(state.source[state.index] ?? '')) state.index += 1;
  if (state.source[state.index] === '.') {
    const decimal = state.index;
    state.index += 1;
    while (/\d/u.test(state.source[state.index] ?? '')) state.index += 1;
    if (decimal + 1 === state.index) state.index = decimal;
  }
  return state.source.slice(start, state.index);
}

function parsePrimary(state: ParserState): MathNode | null {
  skipSpace(state);
  if (consume(state, '(')) {
    const expression = parseExpression(state);
    if (expression === null || !consume(state, ')')) return null;
    return expression;
  }
  const countText = parseNumberText(state);
  skipSpace(state);
  if ((state.source[state.index] ?? '').toLowerCase() === 'd') {
    state.index += 1;
    const sidesText = parseNumberText(state);
    const count = countText === '' ? 1 : Number(countText);
    const sides = Number(sidesText);
    if (
      !Number.isInteger(count) ||
      !Number.isInteger(sides) ||
      count < 1 ||
      count > 100 ||
      sides < 1 ||
      sides > 100_000
    ) {
      return null;
    }
    return { count, kind: 'dice', sides };
  }
  if (countText === '') return null;
  const value = Number(countText);
  return Number.isFinite(value) ? { kind: 'number', value } : null;
}

function parseUnary(state: ParserState): MathNode | null {
  skipSpace(state);
  const character = state.source[state.index];
  if (character === '+' || character === '-') {
    state.index += 1;
    const value = parseUnary(state);
    if (value === null) return null;
    return { kind: 'unary', operator: character, value };
  }
  return parsePrimary(state);
}

function parseTerm(state: ParserState): MathNode | null {
  let left = parseUnary(state);
  if (left === null) return null;
  for (;;) {
    skipSpace(state);
    const operator = state.source[state.index];
    if (operator !== '*' && operator !== '/') return left;
    state.index += 1;
    const right = parseUnary(state);
    if (right === null) return null;
    left = { kind: 'binary', left, operator, right };
  }
}

function parseExpression(state: ParserState): MathNode | null {
  let left = parseTerm(state);
  if (left === null) return null;
  for (;;) {
    skipSpace(state);
    const operator = state.source[state.index];
    if (operator !== '+' && operator !== '-') return left;
    state.index += 1;
    const right = parseTerm(state);
    if (right === null) return null;
    left = { kind: 'binary', left, operator, right };
  }
}

function parse(source: string): MathNode | null {
  const state: ParserState = { index: 0, source };
  const expression = parseExpression(state);
  skipSpace(state);
  return expression === null || state.index !== source.length
    ? null
    : expression;
}

function numberText(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(10)));
}

function evaluate(node: MathNode, random: () => number): DiceRoll {
  switch (node.kind) {
    case 'number':
      return { detail: numberText(node.value), value: node.value };
    case 'dice': {
      const rolls: number[] = [];
      for (let index = 0; index < node.count; index += 1) {
        const bounded = Math.min(0.999_999_999, Math.max(0, random()));
        rolls.push(Math.floor(bounded * node.sides) + 1);
      }
      const value = rolls.reduce((total, roll) => total + roll, 0);
      const detail =
        rolls.length === 1
          ? numberText(rolls[0] ?? 0)
          : `{${rolls.map(numberText).join('+')}}(${numberText(value)})`;
      return { detail, value };
    }
    case 'unary': {
      const value = evaluate(node.value, random);
      return {
        detail: `${node.operator}${value.detail}`,
        value: node.operator === '-' ? -value.value : value.value,
      };
    }
    case 'binary': {
      const left = evaluate(node.left, random);
      const right = evaluate(node.right, random);
      const value =
        node.operator === '+'
          ? left.value + right.value
          : node.operator === '-'
            ? left.value - right.value
            : node.operator === '*'
              ? left.value * right.value
              : left.value / right.value;
      if (!Number.isFinite(value))
        throw new Error('Dice expression is not finite');
      return {
        detail: `${left.detail}${node.operator}${right.detail}`,
        value,
      };
    }
  }
}

export function calculate(source: string): number | null {
  const node = parse(source);
  if (node === null) return null;
  try {
    const result = evaluate(node, () => 0.5).value;
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

export function rollDice(
  source: string,
  random: () => number,
): DiceRoll | null {
  const node = parse(source);
  if (node === null) return null;
  try {
    const result = evaluate(node, random);
    return Number.isFinite(result.value) ? result : null;
  } catch {
    return null;
  }
}

export function formatNumber(value: number): string {
  return numberText(value);
}
