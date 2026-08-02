import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('context data example inspects group, player, and character variables', async () => {
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /rows\(ctx\.group\)/);
  assert.match(source, /'已读取群数据、玩家数据和当前角色卡数据。'/);
  assert.match(source, /seal\.vars\.intGet\(ctx, key\)/);
  assert.match(source, /seal\.vars\.intSet\(ctx, '新属性', 10\)/);
});
