import { relative } from 'node:path';

import { SealwrapperError } from './errors.ts';

type TypeScriptModule = typeof import('typescript');

/**
 * This is the compatibility baseline for the Goja version shipped by the
 * locked SealDice 1.6.0 core.  The list is deliberately conservative and is
 * derived from Goja's pinned Test262 runner feature blacklist.  It is not a
 * claim that every other ECMAScript feature is supported: unsupported entries
 * are the features for which we can produce a useful, deterministic author
 * diagnostic before the archive reaches the host.
 */
export const gojaCompatibilityProfile = Object.freeze({
  id: 'goja@v0.0.0-20260216154549-8b74ce4618c5',
  targetId: '1.6.0',
  ecmaTarget: 'es6',
  test262Commit: 'cb4a6c8074671c00df8cbc17a620c0f9462b312a',
  unsupportedGlobals: new Set([
    'Atomics',
    'FinalizationRegistry',
    'Float16Array',
    'Iterator',
    'SharedArrayBuffer',
    'ShadowRealm',
    'Temporal',
    'AsyncIterator',
    'WeakRef',
  ]),
  unsupportedMembers: new Set([
    'Array.fromAsync',
    'ArrayBuffer.prototype.transferToFixedLength',
    'ArrayBuffer.transfer',
    'ArrayBuffer.prototype.transfer',
    'Atomics.pause',
    'Atomics.waitAsync',
    'Math.sumPrecise',
    'Promise.try',
    'Promise.withResolvers',
    'RegExp.escape',
    'Object.groupBy',
    'Map.groupBy',
    'Set.prototype.difference',
    'Set.prototype.intersection',
    'Set.prototype.isDisjointFrom',
    'Set.prototype.isSubsetOf',
    'Set.prototype.isSupersetOf',
    'Set.prototype.symmetricDifference',
    'Set.prototype.union',
    'String.prototype.isWellFormed',
    'String.prototype.toWellFormed',
    'Symbol.asyncIterator',
    'Uint8Array.fromBase64',
    'Uint8Array.prototype.toBase64',
  ]),
  unsupportedMethodNames: new Set([
    'fromAsync',
    'fromBase64',
    'isDisjointFrom',
    'isSubsetOf',
    'isSupersetOf',
    'isWellFormed',
    'sumPrecise',
    'toWellFormed',
    'toBase64',
    'transferToFixedLength',
    'withResolvers',
  ]),
});

export type GojaCompatibilityDiagnostic = {
  ruleId: string;
  feature: string;
  message: string;
  file: string;
  line: number;
  column: number;
};

/** Goja's profile is intentionally tied to the ES6 output baseline. */
export function assertGojaEcmaTarget(target: string): void {
  if (target !== gojaCompatibilityProfile.ecmaTarget) {
    throw new SealwrapperError(`Goja compatibility profile requires build.ecmaTarget=${gojaCompatibilityProfile.ecmaTarget}; received ${target}`, 2);
  }
}

let typescriptPromise: Promise<TypeScriptModule> | undefined;

async function loadTypeScript(): Promise<TypeScriptModule> {
  typescriptPromise ??= import('typescript');
  try {
    return await typescriptPromise;
  } catch {
    throw new SealwrapperError('Goja compatibility scan requires the locked TypeScript dependency; run npm ci', 3);
  }
}

function lineAndColumn(ts: TypeScriptModule, sourceFile: import('typescript').SourceFile, position: number) {
  const location = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: location.line + 1, column: location.character + 1 };
}

function diagnostic(ts: TypeScriptModule, sourceFile: import('typescript').SourceFile, node: import('typescript').Node, ruleId: string, feature: string, message: string): GojaCompatibilityDiagnostic {
  return { ruleId, feature, message, file: sourceFile.fileName, ...lineAndColumn(ts, sourceFile, node.getStart(sourceFile)) };
}

function propertyPath(ts: TypeScriptModule, node: import('typescript').Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  const parent = propertyPath(ts, node.expression);
  return parent ? `${parent}.${node.name.text}` : undefined;
}

function isAsyncModifier(ts: TypeScriptModule, node: import('typescript').Node & { modifiers?: import('typescript').NodeArray<import('typescript').ModifierLike> }) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
}

function regexBodyFeature(body: string, flags: string): { ruleId: string; feature: string; message: string } | undefined {
  if (/\\[pP]\{/u.test(body)) return { ruleId: 'goja.regexp-unicode-property-escapes', feature: 'regexp-unicode-property-escapes', message: 'Goja does not support Unicode property escapes in regular expressions' };
  if (flags.includes('v')) return { ruleId: 'goja.regexp-v-flag', feature: 'regexp-v-flag', message: 'Goja does not support the RegExp v flag' };
  if (flags.includes('d')) return { ruleId: 'goja.regexp-match-indices', feature: 'regexp-match-indices', message: 'Goja does not support the RegExp match-indices (d) flag' };
  const names = [...body.matchAll(/\(\?<([A-Za-z_$][\w$]*)>/gu)].map((match) => match[1]);
  if (names.length > 0) {
    if (new Set(names).size !== names.length) return { ruleId: 'goja.regexp-duplicate-named-groups', feature: 'regexp-duplicate-named-groups', message: 'Goja does not support duplicate named capture groups' };
    return { ruleId: 'goja.regexp-named-groups', feature: 'regexp-named-groups', message: 'Goja does not support named capture groups' };
  }
  return undefined;
}

function regexFeature(text: string): { ruleId: string; feature: string; message: string } | undefined {
  const lastSlash = text.lastIndexOf('/');
  return lastSlash > 0 ? regexBodyFeature(text.slice(1, lastSlash), text.slice(lastSlash + 1)) : undefined;
}

function sourceKind(file: string, ts: TypeScriptModule): import('typescript').ScriptKind {
  if (/\.tsx?$/u.test(file)) return ts.ScriptKind.TSX;
  if (/\.json$/u.test(file)) return ts.ScriptKind.JSON;
  return ts.ScriptKind.JS;
}

/** Scan one source or generated bundle without executing author code. */
export async function scanGojaCompatibility(code: string, file = '<bundle>'): Promise<GojaCompatibilityDiagnostic[]> {
  const ts = await loadTypeScript();
  const sourceFile = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, sourceKind(file, ts));
  const diagnostics: GojaCompatibilityDiagnostic[] = [];
  const seen = new Set<string>();
  const report = (item: GojaCompatibilityDiagnostic) => {
    const key = `${item.ruleId}:${item.file}:${item.line}:${item.column}`;
    if (!seen.has(key)) { seen.add(key); diagnostics.push(item); }
  };

  function visit(node: import('typescript').Node) {
    if (ts.isRegularExpressionLiteral(node)) {
      const feature = regexFeature(node.text);
      if (feature) report(diagnostic(ts, sourceFile, node, feature.ruleId, feature.feature, feature.message));
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && propertyPath(ts, node.expression) === 'RegExp') {
      const pattern = node.arguments?.[0];
      const flags = node.arguments?.[1];
      if (pattern && ts.isStringLiteralLike(pattern)) {
        const feature = regexBodyFeature(pattern.text, flags && ts.isStringLiteralLike(flags) ? flags.text : '');
        if (feature) report(diagnostic(ts, sourceFile, node, feature.ruleId, feature.feature, feature.message));
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      report(diagnostic(ts, sourceFile, node, 'goja.dynamic-import', 'dynamic-import', 'Goja does not support dynamic import() in SealDice bundles'));
    }
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      report(diagnostic(ts, sourceFile, node, 'goja.import-meta', 'import.meta', 'Goja does not support import.meta in SealDice bundles'));
    }
    if (ts.isForOfStatement(node) && node.awaitModifier) {
      report(diagnostic(ts, sourceFile, node, 'goja.async-iteration', 'async-iteration', 'Goja does not support for-await-of iteration'));
    }
    const functionLike = (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) ? node as import('typescript').FunctionLikeDeclaration : undefined;
    if (functionLike?.asteriskToken && isAsyncModifier(ts, functionLike)) {
      report(diagnostic(ts, sourceFile, node, 'goja.async-iteration', 'async-iteration', 'Goja does not support async generator functions'));
    }
    if (node.kind === ts.SyntaxKind.Decorator) {
      report(diagnostic(ts, sourceFile, node, 'goja.decorators', 'decorators', 'Goja does not support ECMAScript decorators'));
    }
    // AwaitUsing includes the Using bit (and the Const bit), so testing the
    // Using bit alone avoids misclassifying every `const` declaration.
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Using) !== 0) {
      report(diagnostic(ts, sourceFile, node, 'goja.explicit-resource-management', 'explicit-resource-management', 'Goja does not support using/await using declarations'));
    }
    if (node.kind === ts.SyntaxKind.ImportAttributes || node.kind === ts.SyntaxKind.ImportTypeAssertionContainer) {
      report(diagnostic(ts, sourceFile, node, 'goja.import-attributes', 'import-attributes', 'Goja does not support import attributes or assertions'));
    }
    if (ts.isPropertyAccessExpression(node)) {
      const path = propertyPath(ts, node);
      if (path && gojaCompatibilityProfile.unsupportedMembers.has(path)) {
        report(diagnostic(ts, sourceFile, node, `goja.${path.toLowerCase().replaceAll('.', '-')}`, path, `Goja does not support ${path}`));
      } else if (gojaCompatibilityProfile.unsupportedMethodNames.has(node.name.text)) {
        const method = node.name.text;
        report(diagnostic(ts, sourceFile, node, `goja.${method.toLowerCase()}`, method, `Goja does not support the ${method} method`));
      }
    }
    if (ts.isIdentifier(node) && gojaCompatibilityProfile.unsupportedGlobals.has(node.text)) {
      const parent = node.parent;
      const isPropertyName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      const isDeclaration = (ts.isVariableDeclaration(parent) && parent.name === node)
        || (ts.isParameter(parent) && parent.name === node)
        || (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node))
        || ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === node)
        || ((ts.isImportClause(parent) || ts.isImportSpecifier(parent)) && parent.name === node);
      const isMemberObject = ts.isPropertyAccessExpression(parent) && parent.expression === node;
      if (!isPropertyName && !isDeclaration && !isMemberObject) {
        report(diagnostic(ts, sourceFile, node, `goja.global-${node.text.toLowerCase()}`, node.text, `Goja does not provide the global ${node.text}`));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return diagnostics.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column || left.ruleId.localeCompare(right.ruleId));
}

function renderDiagnostics(diagnostics: readonly GojaCompatibilityDiagnostic[], projectRoot?: string): string {
  return diagnostics.map((item) => `${projectRoot ? relative(projectRoot, item.file) : item.file}:${item.line}:${item.column} ${item.ruleId}: ${item.message}`).join('\n');
}

export async function assertGojaCompatibility(code: string, file: string, projectRoot?: string): Promise<void> {
  const diagnostics = await scanGojaCompatibility(code, file);
  if (diagnostics.length > 0) throw new SealwrapperError(`Goja compatibility scan failed:\n${renderDiagnostics(diagnostics, projectRoot)}`, 1);
}
