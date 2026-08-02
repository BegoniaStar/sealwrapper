import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('automatic reply and JS command share the exported JSON deck group', async () => {
  const deck = JSON.parse(await readFile(join(root, 'content/decks/adventure-prompts.json'), 'utf8'));
  const reply = await readFile(join(root, 'content/reply/adventure.yaml'), 'utf8');
  const script = await readFile(join(root, 'src/index.ts'), 'utf8');

  assert.deepEqual(deck._export, ['冒险灵感']);
  assert.equal(deck.冒险灵感.length, 3);
  assert.match(reply, /#\{DRAW-冒险灵感\}/);
  assert.match(script, /seal\.deck\.draw\(ctx, deckName, false\)/);
});
