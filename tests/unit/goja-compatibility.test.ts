import assert from 'node:assert/strict';
import test from 'node:test';

import { assertGojaEcmaTarget, gojaCompatibilityProfile, scanGojaCompatibility } from '../../src/goja-compatibility.ts';

test('Goja compatibility profile is pinned to the managed core and Test262 baseline', () => {
  assert.equal(gojaCompatibilityProfile.targetId, '1.6.0');
  assert.match(gojaCompatibilityProfile.id, /^goja@/u);
  assert.match(gojaCompatibilityProfile.test262Commit, /^[0-9a-f]{40}$/u);
  assert.equal(gojaCompatibilityProfile.ecmaTarget, 'es6');
  assert.doesNotThrow(() => assertGojaEcmaTarget('es6'));
  assert.throws(() => assertGojaEcmaTarget('es2020'), /build\.ecmaTarget=es6/);
});

test('Goja compatibility scan accepts the supported ES6 and host API surface', async () => {
  const diagnostics = await scanGojaCompatibility(`
    const values = new Map<string, number>();
    values.set('answer', 42);
    const response = globalThis.fetch;
    void response;
  `, 'src/index.ts');
  assert.deepEqual(diagnostics, []);
});

test('Goja compatibility scan reports syntax, built-in, and regular-expression gaps', async () => {
  const diagnostics = await scanGojaCompatibility([
    'async function* values() { yield 1; }',
    'const load = import("module");',
    'const weak = new WeakRef({});',
    'const pending = Promise.withResolvers();',
    String.raw`const letters = /\p{Letter}/u;`,
  ].join('\n'), 'src/index.ts');
  assert.deepEqual(diagnostics.map((item) => item.feature), [
    'async-iteration',
    'dynamic-import',
    'WeakRef',
    'Promise.withResolvers',
    'regexp-unicode-property-escapes',
  ]);
  assert.match(diagnostics[0].ruleId, /^goja\./u);
  assert.equal(diagnostics[2].line, 3);
});

test('Goja compatibility scan catches features introduced by esbuild helpers', async () => {
  const diagnostics = await scanGojaCompatibility('const iterator = Symbol.asyncIterator;', 'scripts/bundle.js');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].feature, 'Symbol.asyncIterator');
});
