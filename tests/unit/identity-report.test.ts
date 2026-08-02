import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveIdentities } from '../../src/identity.ts';
import { writeScenarioReport } from '../../src/reports.ts';

const transcript = {
  title: '身份测试', conversation: { kind: 'group', id: '1', name: '群' },
  messages: [{ sequence: 1, timestamp: '2026-08-01T00:00:00Z', direction: 'in', qq: '10001', nickname: '场景昵称', text: 'hello' }],
};

test('offline identity resolution falls back without changing the transcript assertion data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-identity-'));
  const original = structuredClone(transcript);
  const resolved = await resolveIdentities({ projectRoot: root, transcript, offline: true });
  assert.deepEqual(transcript, original);
  assert.equal(resolved.transcript.messages[0].identitySource, 'scenario');
  assert.equal(resolved.warnings.length, 1);
});

test('public avatar retrieval is independent from public nickname lookup', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-identity-online-'));
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://users.qzone.qq.com/fcg-bin/cgi_get_portrait.fcg?')) {
      return new Response('portraitCallBack({"3909311212":["http://qlogo1.store.qq.com/qzone/3909311212/3909311212/100",38,-1,0,0,0,"测试昵称",0]})', { headers: { 'content-type': 'text/plain' } });
    }
    if (url.startsWith('https://q1.qlogo.cn/g?')) {
      return new Response(Buffer.from('jpeg-avatar'), { headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response('_Callback({"error":{"type":"need login"}})', { status: 401 });
  }) as typeof fetch;

  const online = structuredClone(transcript);
  online.messages[0].qq = '3909311212';
  const resolved = await resolveIdentities({ projectRoot: root, transcript: online });
  assert.equal(resolved.transcript.messages[0].nickname, '场景昵称');
  assert.equal(resolved.transcript.messages[0].avatarData, `data:image/jpeg;base64,${Buffer.from('jpeg-avatar').toString('base64')}`);
  assert.equal(resolved.identities['3909311212'].nickname, '场景昵称');
  assert.ok(calls.some((url) => url.startsWith('https://users.qzone.qq.com/')));
  assert.ok(calls.some((url) => url.startsWith('https://q1.qlogo.cn/')));
});

test('public nickname is retained when the avatar endpoint is temporarily unavailable', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-identity-nickname-only-'));
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.startsWith('https://users.qzone.qq.com/fcg-bin/cgi_get_portrait.fcg?')) {
      return new Response('portraitCallBack({"3909311212":["http://qlogo.invalid/avatar",38,-1,0,0,0,"昵称可用",0]})', { headers: { 'content-type': 'text/plain' } });
    }
    if (url.startsWith('https://q1.qlogo.cn/g?')) return new Response('temporary failure', { status: 503 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const online = structuredClone(transcript);
  online.messages[0].qq = '3909311212';
  online.messages[0].nickname = '';
  const resolved = await resolveIdentities({ projectRoot: root, transcript: online });
  assert.equal(resolved.transcript.messages[0].nickname, '昵称可用');
  assert.equal(resolved.transcript.messages[0].avatarData, undefined);
  assert.equal(resolved.identities['3909311212'].nickname, '昵称可用');
  assert.match(resolved.warnings.join('\n'), /avatar|public identity/i);
});

test('public nickname decoding preserves the GB18030 portrait response used by QQ', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-identity-gb18030-'));
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const portraitPrefix = 'portraitCallBack({"3909311212":["http://qlogo1.store.qq.com/qzone/3909311212/3909311212/100",38,-1,0,0,0,"';
  const portraitSuffix = '",0]})';
  const nicknameGbk = Buffer.from([0xea, 0xc7, 0xb3, 0xc6]); // “昵称” in GB18030
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.startsWith('https://users.qzone.qq.com/fcg-bin/cgi_get_portrait.fcg?')) {
      return new Response(Buffer.concat([Buffer.from(portraitPrefix, 'ascii'), nicknameGbk, Buffer.from(portraitSuffix, 'ascii')]), { headers: { 'content-type': 'text/plain; charset=gbk' } });
    }
    if (url.startsWith('https://q1.qlogo.cn/g?')) return new Response(Buffer.from('jpeg-avatar'), { headers: { 'content-type': 'image/jpeg' } });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const online = structuredClone(transcript);
  online.messages[0].qq = '3909311212';
  online.messages[0].nickname = '';
  const resolved = await resolveIdentities({ projectRoot: root, transcript: online });
  assert.equal(resolved.transcript.messages[0].nickname, '昵称');
  assert.equal(resolved.identities['3909311212'].nickname, '昵称');
});

test('reports freeze identity assets and keep exported HTML/SVG offline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-report-'));
  await mkdir(join(root, '.seal', 'identity-cache'), { recursive: true });
  await writeFile(join(root, '.seal', 'identity-cache', '10001.json'), `${JSON.stringify({ qq: '10001', nickname: '缓存昵称', avatarBase64: Buffer.from('avatar').toString('base64'), avatarContentType: 'image/png', fetchedAt: new Date().toISOString(), provider: 'qq-public' })}\n`);
  const result = await writeScenarioReport({ projectRoot: root, name: 'case', transcript, offline: true });
  const html = await readFile(result.html, 'utf8');
  const svg = await readFile(result.svg, 'utf8');
  const exported = JSON.parse(await readFile(result.json, 'utf8'));
  assert.doesNotMatch(html, /https:\/\//);
  assert.doesNotMatch(svg, /https:\/\//);
  await access(join(root, '.seal', 'reports', 'case.avatars', '10001.png'));
  assert.equal(exported.messages[0].avatarData, undefined);
  assert.equal(exported.messages[0].avatarPath, 'case.avatars/10001.png');
  assert.match(html, /case\.avatars\/10001\.png/);
  assert.match(await readFile(result.identities, 'utf8'), /"warnings"/);
});

test('identity resolver rejects malformed cache entries instead of trusting their fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-identity-invalid-cache-'));
  await mkdir(join(root, '.seal', 'identity-cache'), { recursive: true });
  await writeFile(join(root, '.seal', 'identity-cache', '10001.json'), `${JSON.stringify({
    qq: '10001', nickname: '伪造', avatarBase64: 'not-base64', avatarContentType: 'image/svg+xml',
    fetchedAt: 'not-a-timestamp', provider: 'qq-public', extra: 'unexpected',
  })}\n`);
  const resolved = await resolveIdentities({ projectRoot: root, transcript, offline: true });
  assert.equal(resolved.transcript.messages[0].identitySource, 'scenario');
  assert.equal(resolved.transcript.messages[0].avatarData, undefined);
  assert.match(resolved.warnings.join('\n'), /cache miss/);
});

test('reports optionally rasterize the frozen SVG into a PNG after HTML export', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-report-png-'));
  const calls: Array<{ svg: string; png: string }> = [];
  const result = await writeScenarioReport({
    projectRoot: root,
    name: 'png-case',
    transcript,
    offline: true,
    png: true,
    pngExporter: async ({ svg, png }: { svg: string; png: string }) => {
      calls.push({ svg, png });
      await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].svg, result.svg);
  assert.equal(calls[0].png, result.png);
  assert.ok(result.png);
  await access(result.png);
});

test('P2 reports freeze inline message images and retain chosen export controls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-report-assets-'));
  const rich = structuredClone(transcript) as any;
  rich.conversation.members = [{ qq: '10001', nickname: '场景昵称' }];
  rich.messages[0].segments = [{ type: 'image', alt: '角色卡', data: `data:image/png;base64,${Buffer.from('image').toString('base64')}` }];
  const result = await writeScenarioReport({ projectRoot: root, name: 'rich', transcript: rich, offline: true, theme: 'dark', style: 'compact', showMembers: true });
  const html = await readFile(result.html, 'utf8');
  const svg = await readFile(result.svg, 'utf8');
  await access(join(root, '.seal', 'reports', 'rich.assets', 'message-1-1.png'));
  assert.match(html, /data-theme="dark"/);
  assert.match(svg, /rich\.assets\/message-1-1\.png/);
  assert.match(svg, /成员：场景昵称/);
});
