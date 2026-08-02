import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { measureSvgText, renderHtml, renderSvg, wrapSvgText } from '../../src/renderer.ts';

const transcript = {
  title: 'QQ群',
  conversation: { kind: 'group', id: '1', name: '测试群', memberCount: 2 },
  messages: [{
    sequence: 2, timestamp: '2026-08-01T03:14:00+08:00', direction: 'out',
    qq: '10000', nickname: '<骰娘>', identitySource: 'placeholder',
    reply: { nickname: '甲', timestamp: '03:13', text: '<quoted>' }, text: '<script>alert(1)</script>',
  }, {
    sequence: 1, timestamp: '2026-08-01T03:12:00+08:00', direction: 'in',
    qq: '10001', nickname: '甲', identitySource: 'scenario', text: '你好',
  }],
};

test('offline renderer preserves stable sequence order and escapes untrusted text', () => {
  const svg = renderSvg(transcript);
  const html = renderHtml(transcript);
  assert.ok(svg.indexOf('你好') < svg.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.match(svg, /&lt;quoted&gt;/);
  assert.doesNotMatch(html, /https:\/\//);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /type="application\/json"/);
  assert.match(svg, /font-family="Noto Serif CJK SC, Noto Serif CJK, serif"/);
  assert.match(html, /font-family:"Noto Serif CJK SC","Noto Serif CJK",serif/);
});

test('renderer keeps the bridge timeline when reply sequence IDs are not chronological', () => {
  const chronological = {
    conversation: { kind: 'group', name: '连续对话' },
    messages: [
      { sequence: 1, transcriptSequence: 1, direction: 'in', qq: '1', nickname: 'Alice', text: '第一条' },
      { sequence: 3, transcriptSequence: 2, direction: 'out', inReplyToSequence: 1, qq: '100000', nickname: 'TestBot', text: '第一条回复' },
      { sequence: 2, transcriptSequence: 3, direction: 'in', qq: '1', nickname: 'Alice', text: '第二条' },
      { sequence: 4, transcriptSequence: 4, direction: 'out', inReplyToSequence: 2, qq: '100000', nickname: 'TestBot', text: '第二条回复' },
    ],
  };
  const svg = renderSvg(chronological);
  assert.ok(svg.indexOf('第一条') < svg.indexOf('第一条回复'));
  assert.ok(svg.indexOf('第一条回复') < svg.indexOf('第二条'));
  assert.ok(svg.indexOf('第二条') < svg.indexOf('第二条回复'));
});

test('P2 renderer exports forwarded/image segments, members, and explicit offline themes/styles', () => {
  const rich = {
    conversation: { kind: 'group', id: '1', name: '群', members: [{ qq: '1', nickname: '甲', role: 'owner' }, { qq: '2', nickname: '乙', role: 'admin' }] },
    messages: [{ sequence: 1, direction: 'in', qq: '1', nickname: '甲', segments: [
      { type: 'forward', title: '转发聊天记录', summary: '两条转发消息', messages: [{ nickname: '乙', text: '你好' }] },
      { type: 'image', alt: '角色卡', assetPath: 'case.assets/card.png' },
    ] }],
  };
  const svg = renderSvg(rich, { theme: 'dark', style: 'compact', showMembers: true });
  const html = renderHtml(rich, { theme: 'dark', style: 'compact', showMembers: true });
  assert.match(svg, /转发聊天记录/);
  assert.match(svg, /成员：甲、乙/);
  assert.match(svg, /case\.assets\/card\.png/);
  assert.match(html, /data-theme="dark"/);
  assert.doesNotMatch(html, /https:\/\//);
});

test('renderer wraps long CJK and unbroken Latin text by visual width without dropping lines', () => {
  const cjk = '这是用于验证聊天气泡自动换行的长消息。'.repeat(12);
  const url = `https://example.invalid/${'a'.repeat(420)}`;
  const cjkLines = wrapSvgText(cjk, 240, 19);
  const urlLines = wrapSvgText(url, 240, 19);

  assert.ok(cjkLines.length > 12);
  assert.ok(urlLines.length > 1);
  assert.equal(cjkLines.join(''), cjk);
  assert.equal(urlLines.join(''), url);
  assert.ok(cjkLines.every((line) => measureSvgText(line, 19) <= 240));
  assert.ok(urlLines.every((line) => measureSvgText(line, 19) <= 240));

  const svg = renderSvg({ conversation: { kind: 'group', name: '长消息群' }, messages: [{ sequence: 1, direction: 'in', qq: '10001', nickname: '甲', text: cjk }] });
  const rendered = [...svg.matchAll(/font-size="19" xml:space="preserve">(.*?)<\/text>/g)].map((match) => match[1]);
  assert.ok(rendered.length > 8); // Regression: the old SVG renderer silently kept only eight lines.
  assert.equal(rendered.join(''), cjk);
});

test('renderer keeps a deterministic prototype-derived SVG/HTML golden baseline', () => {
  const golden = {
    title: 'Golden QQ',
    conversation: { kind: 'group', id: 'g', name: '基线群', members: [{ qq: '10001', nickname: '甲', role: 'owner' }, { qq: '10002', nickname: '乙', role: 'admin' }] },
    messages: [
      { sequence: 1, transcriptSequence: 1, timestamp: '2026-08-01T00:00:00.000Z', direction: 'in', scope: 'group', qq: '10001', nickname: '甲', role: 'owner', text: '第一条消息：这是一个较长的中文文本，用于验证换行。', segments: [{ type: 'at', target: '100000' }] },
      { sequence: 4, transcriptSequence: 2, timestamp: '2026-08-01T00:00:00.100Z', direction: 'out', scope: 'group', qq: '100000', nickname: 'TestBot', role: 'bot', reply: { nickname: '甲', timestamp: '00:00', text: '第一条消息' }, text: '回复第一段\n回复第二段' },
      { sequence: 2, transcriptSequence: 3, timestamp: '2026-08-01T00:06:00.000Z', direction: 'in', scope: 'group', qq: '10002', nickname: '乙', role: 'admin', text: '第二条', segments: [{ type: 'image', alt: '图', assetPath: 'golden.assets/x.png' }] },
    ],
  };
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const svg = renderSvg(golden);
  const html = renderHtml(golden);
  const compactSvg = renderSvg(golden, { theme: 'dark', style: 'compact', showMembers: true });
  const compactHtml = renderHtml(golden, { theme: 'dark', style: 'compact', showMembers: true });
  assert.equal(digest(svg), '507b536474a18a3563f1ac0d7350049d88779325ba1a94faa943b624fad1ee29');
  assert.equal(digest(html), 'e1aed35383eaf740237207ea6f09614549c07cabe6bc6e5d02dd0cc7c66f1bce');
  assert.equal(digest(compactSvg), '034addb682900e790c4f2ee47f75c299592977c2eaa19f11ec376b106fb0f2ba');
  assert.equal(digest(compactHtml), '5fdb941385517c86d2d58d184824c27442009871f9f77f07fa211ac88c212923');
  assert.match(svg, /font-family="Noto Serif CJK SC, Noto Serif CJK, serif"/);
  assert.match(html, /font-family:"Noto Serif CJK SC","Noto Serif CJK",serif/);
});
