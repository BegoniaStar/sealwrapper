import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareApiInventories,
  loadApiContract,
  renderApiDeclaration,
  validateDeclarationCoverage,
} from '../../src/api-contract.ts';

const inventory = {
  schemaVersion: 1,
  scannerVersion: 2,
  target: '1.6.0',
  core: {
    commit: 'a'.repeat(40),
    runtimeVersion: '1.6.0+20260726',
    sourceDeclaredVersion: '1.5.1-dev',
    sourceFingerprint: 'sha256:test',
  },
  entries: [
    { path: 'seal.ext', kind: 'object', source: 'dice/dice_jsvm.go:1' },
    { path: 'seal.ext.new', kind: 'function', arity: 3, goSignature: 'func(string, string, string) *ExtInfo', source: 'dice/dice_jsvm.go:2' },
    { path: 'seal.replyToSender', kind: 'function', arity: 3, goSignature: 'func(*MsgContext, *Message, string)', source: 'dice/dice_jsvm.go:3' },
  ],
  types: {},
} as const;

const semantic = {
  schemaVersion: 1,
  target: '1.6.0',
  template: 'api/sealdice/1.6.0/seal.d.ts.template',
  declarationOnlyPaths: [],
  inventoryOnlyPaths: [],
} as const;

const template = `declare namespace seal {
  export const ext: {
    new: (name: string, author: string, version: string) => ExtInfo;
  };
  export function replyToSender(ctx: MsgContext, msg: Message, text: string): void;
  export interface ExtInfo { name: string; }
  export interface MsgContext {}
  export interface Message {}
}
`;

test('type contract renderer writes pinned provenance and covers extracted API paths', () => {
  const rendered = renderApiDeclaration(inventory, semantic, template);
  assert.match(rendered, /Generated from the lock-pinned SealDice API inventory/);
  assert.match(rendered, /Source core: a{40}/);
  assert.match(rendered, /API inventory: sha256:/);
  assert.doesNotThrow(() => validateDeclarationCoverage(inventory, semantic, template));
});

test('type contract coverage rejects omitted or impossible API declarations', () => {
  const missing = template.replace(/  export function replyToSender[\s\S]*?\n/, '');
  assert.throws(() => validateDeclarationCoverage(inventory, semantic, missing), /seal\.replyToSender/);
  const tooManyParameters = template.replace('version: string', 'version: string, forbidden: string');
  assert.throws(() => validateDeclarationCoverage(inventory, semantic, tooManyParameters), /seal\.ext\.new/);
});

test('inventory comparison reports exact added, removed, and signature changes', () => {
  const changed = structuredClone(inventory);
  changed.entries[1].arity = 2;
  changed.entries.push({ path: 'seal.deck', kind: 'object', source: 'dice/dice_jsvm.go:4' });
  const differences = compareApiInventories(inventory, changed);
  assert.ok(differences.some((line) => line.includes('Changed: seal.ext.new')));
  assert.ok(differences.some((line) => line.includes('Added: seal.deck')));
});

test('checked-in 1.6.0 contract is generated from a complete pinned AST inventory', async () => {
  const contract = await loadApiContract();
  assert.equal(contract.inventory.target, '1.6.0');
  assert.equal(contract.inventory.entries.length, 62);
  assert.ok(contract.inventory.entries.some((entry) => entry.path === 'seal.ext.new'));
  assert.match(contract.declaration, /Generated from the lock-pinned SealDice API inventory/);
  assert.match(contract.report, /seal\.replyToSender/);
});
