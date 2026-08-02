import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('deck command uses the project-local exported investigator deck', async () => {
  const deck = JSON.parse(await readFile(new URL('../../content/decks/investigators.json', import.meta.url), 'utf8'));
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
  assert.deepEqual(deck._export, ['调查员']);
  assert.match(source, /seal\.deck\.draw\(ctx, deckName, true\)/);
  assert.match(source, /templatePrefix\.startsWith\('<%未知项-'/);
});
