import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

async function loadAdmin() {
  const directory = await mkdtemp(join(tmpdir(), 'lightscript-loader-unit-'));
  const outfile = join(directory, 'admin.mjs');
  await build({ bundle: true, entryPoints: [join(process.cwd(), 'src/lightscript/admin.ts')], format: 'esm', outfile, platform: 'node', target: 'es2024' });
  return import(pathToFileURL(outfile).href);
}

async function loadRuntimeReplies() {
  const directory = await mkdtemp(join(tmpdir(), 'lightscript-loader-runtime-replies-'));
  const outfile = join(directory, 'runtime-replies.mjs');
  await build({ bundle: true, entryPoints: [join(process.cwd(), 'src/lightscript/runtime-replies.ts')], format: 'esm', outfile, platform: 'node', target: 'es2024' });
  return import(pathToFileURL(outfile).href);
}

test('回雪管理只允许骰主或完整 ID/纯 QQ 白名单', async () => {
  const { isManagementAllowed } = await loadAdmin();
  assert.equal(isManagementAllowed(0, 'QQ:30001', ''), false);
  assert.equal(isManagementAllowed(60, 'QQ:30002', ''), false);
  assert.equal(isManagementAllowed(100, 'QQ:30003', ''), true);
  assert.equal(isManagementAllowed(0, 'QQ:30004', '30004'), true);
  assert.equal(isManagementAllowed(0, 'QQ:30005', 'QQ:30004'), false);
});

test('骰主可持久化一个精确关键词的回雪运行时代码', async () => {
  const { RuntimeReplyStore } = await loadRuntimeReplies();
  const state = new Map<string, string>();
  const store = new RuntimeReplyStore({ storageGet: (key: string) => state.get(key) ?? '', storageSet: (key: string, value: string) => { state.set(key, value); } }, { report: () => {} });
  assert.deepEqual(store.upsertProgram('今日人品', '今日人品为 #{JRRP-}'), { kind: 'added' });
  assert.deepEqual(store.find('今日人品'), { keyword: '今日人品', program: '今日人品为 #{JRRP-}' });
});
