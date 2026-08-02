type RecordValue = Record<string, any>;
export type RenderOptions = { theme?: 'light' | 'dark' | 'classic'; style?: 'comfortable' | 'compact'; showMembers?: boolean };

const themes = {
  light: { page: '#f2f2f2', header: '#ffffff', text: '#161616', muted: '#858585', inbound: '#ffffff', outbound: '#95ec69', quote: '#e3e3e3', quoteText: '#202020' },
  dark: { page: '#1d2228', header: '#292f36', text: '#edf2f7', muted: '#b5bdc8', inbound: '#343c46', outbound: '#4d8640', quote: '#252c34', quoteText: '#e0e6ed' },
  classic: { page: '#ebe4d8', header: '#f8f3ea', text: '#2d2823', muted: '#7e7166', inbound: '#ffffff', outbound: '#c9e7a4', quote: '#e9e0d4', quoteText: '#40372d' },
} as const;
const reportFontFamily = 'Noto Serif CJK SC, Noto Serif CJK, serif';
const reportFontCss = '"Noto Serif CJK SC","Noto Serif CJK",serif';

function isRecord(value: unknown): value is RecordValue { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
function escapeXml(value: unknown): string { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function messages(transcript: any): RecordValue[] {
  if (!Array.isArray(transcript?.messages)) return [];
  return (transcript.messages.filter(isRecord) as RecordValue[]).sort((left: RecordValue, right: RecordValue) => {
    // Input sequence IDs are chosen by the scenario author and are retained so
    // `inReplyToSequence` is useful.  A reply can therefore be emitted between
    // input IDs 1 and 2 while carrying its own non-chronological ID.  The
    // bridge supplies transcriptSequence precisely for that visual timeline.
    const leftTimeline = Number(left.transcriptSequence);
    const rightTimeline = Number(right.transcriptSequence);
    if (Number.isFinite(leftTimeline) && Number.isFinite(rightTimeline)) return leftTimeline - rightTimeline;
    return Number(left.sequence ?? 0) - Number(right.sequence ?? 0);
  });
}
function avatarLabel(message: RecordValue): string { return (text(message.nickname, '?').trim().slice(0, 1).toUpperCase() || '?'); }
function hue(seed: string): number { let hash = 2166136261; for (const character of seed) { hash ^= character.codePointAt(0) ?? 0; hash = Math.imul(hash, 16777619); } return Math.abs(hash) % 360; }
function readableTime(value: unknown): string { const found = text(value).match(/T(\d{2}:\d{2})/); return found ? found[1] : text(value, '未指定时间'); }
function needsTimeDivider(previous: RecordValue | null, current: RecordValue): boolean { if (current.showTimestamp === true) return true; if (!previous) return false; const before = Date.parse(text(previous.timestamp)); const after = Date.parse(text(current.timestamp)); if (Number.isFinite(before) && Number.isFinite(after)) return after - before >= 5 * 60 * 1000; return text(previous.timestamp).slice(0, 10) !== text(current.timestamp).slice(0, 10); }

// The HTML prototype uses `white-space: pre-wrap` and `overflow-wrap: anywhere`.
// SVG has no equivalent portable line layout, so use a deterministic approximation
// rather than UTF-16 character counts. It deliberately remains browser-free: reports
// must be reproducible in the CLI and remain offline after export.
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const combiningMark = /\p{Mark}/u;
const cjkOrFullWidth = /[\u1100-\u11ff\u2e80-\u2fff\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3130-\u318f\u3190-\u31ef\u3200-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff01-\uff60\uffe0-\uffee]/u;
const emoji = /[\u{1f000}-\u{1faff}\u{2600}-\u{27bf}]/u;
const narrowLatin = /^[ilI1.,'`!|:;]$/;
const wideLatin = /^[WM@%&#]$/;
const breakAfter = /[\s\-_/\\.,;:!?&=#、，。；：！？]/u;

function graphemes(value: string): string[] { return [...graphemeSegmenter.segment(value)].map((part) => part.segment); }
function clusterWidth(cluster: string, fontSize: number): number {
  if (!cluster || [...cluster].every((character) => combiningMark.test(character) || character === '\u200d' || /[\ufe00-\ufe0f]/u.test(character))) return 0;
  if (emoji.test(cluster) || cjkOrFullWidth.test(cluster)) return fontSize;
  if (/^\s$/u.test(cluster)) return fontSize * 0.33;
  if (narrowLatin.test(cluster)) return fontSize * 0.32;
  if (wideLatin.test(cluster)) return fontSize * 0.85;
  return fontSize * 0.56;
}

/** Deterministic text width approximation for the offline SVG report renderer. */
export function measureSvgText(value: string, fontSize: number): number {
  return graphemes(value).reduce((total, cluster) => total + clusterWidth(cluster, fontSize), 0);
}

/**
 * SVG counterpart to the prototype's `pre-wrap` + `overflow-wrap:anywhere`.
 * Explicit newlines and every grapheme are retained; long URLs and CJK text can
 * break anywhere when no natural whitespace/punctuation break is available.
 */
export function wrapSvgText(value: unknown, maxWidth: number, fontSize = 19): string[] {
  const source = typeof value === 'string' ? value : '[空消息]';
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return source.split('\n');
  const result: string[] = [];
  for (const sourceLine of source.split('\n')) {
    if (!sourceLine) { result.push(''); continue; }
    let current: string[] = [];
    let currentWidth = 0;
    let lastBreak = -1;
    for (const cluster of graphemes(sourceLine)) {
      const width = clusterWidth(cluster, fontSize);
      while (current.length && currentWidth + width > maxWidth) {
        if (lastBreak > 0) {
          result.push(current.slice(0, lastBreak).join(''));
          current = current.slice(lastBreak);
          currentWidth = measureSvgText(current.join(''), fontSize);
        } else {
          result.push(current.join(''));
          current = [];
          currentWidth = 0;
        }
        lastBreak = -1;
        for (let index = 0; index < current.length; index += 1) if (breakAfter.test(current[index]!)) lastBreak = index + 1;
      }
      current.push(cluster);
      currentWidth += width;
      if (breakAfter.test(cluster)) lastBreak = current.length;
    }
    result.push(current.join(''));
  }
  return result;
}

function safeVisualSource(value: unknown): string {
  const source = text(value);
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(source)) return source;
  if (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(source) && !source.includes('..') && !source.startsWith('//')) return source;
  return '';
}

function forwardTextLines(segment: RecordValue): string[] {
  const preview = [`转发：${text(segment.title, '聊天记录')}`];
  if (segment.summary) preview.push(text(segment.summary));
  const forwarded = Array.isArray(segment.messages) ? segment.messages.filter(isRecord).slice(0, 2) : [];
  for (const item of forwarded) preview.push(`${text(item.nickname, '成员')}：${text(item.text, '[非文本消息]')}`);
  return preview;
}

function messageTextLines(message: RecordValue): string[] {
  const result = typeof message.text === 'string' ? [message.text] : [];
  if (Array.isArray(message.segments)) for (const raw of message.segments) {
    if (!isRecord(raw)) continue;
    if (raw.type === 'text') result.push(text(raw.text));
    else if (raw.type === 'image') result.push(`[图片] ${text(raw.alt, '图片消息')}`);
    else if (raw.type === 'forward') result.push(...forwardTextLines(raw));
    else if (raw.type) result.push(`[未渲染的 ${text(raw.type)} 消息段]`);
  }
  return result.length ? result : ['[空消息]'];
}

function widestLine(lines: readonly string[], fontSize: number): number {
  return Math.max(0, ...lines.flatMap((line) => line.split('\n').map((part) => measureSvgText(part, fontSize))));
}

function roleInfo(role: unknown) {
  if (role === 'owner') return { label: '群主', color: '#d4a017' };
  if (role === 'admin') return { label: '管理员', color: '#4e8fd6' };
  if (role === 'bot') return { label: '机器人', color: '#6b7dce' };
  return null;
}

function imageSources(message: RecordValue): string[] {
  const sources: string[] = [];
  for (const item of Array.isArray(message.segments) ? message.segments : []) if (isRecord(item) && item.type === 'image') {
    const source = safeVisualSource(item.assetPath ?? item.data ?? item.dataUrl ?? item.path);
    if (source) sources.push(source);
  }
  return sources;
}

function svgBubble(message: RecordValue, y: number, width: number, palette: (typeof themes)[keyof typeof themes], compact: boolean): { markup: string; height: number } {
  const out = message.direction === 'out';
  const reply = isRecord(message.reply) ? message.reply : null;
  const fontSize = compact ? 17 : 19;
  const sourceLines = messageTextLines(message);
  const replyTitle = reply ? `${text(reply.nickname, '引用消息')}${text(reply.timestamp) ? ` ${text(reply.timestamp)}` : ''}` : '';
  const replyText = reply ? (typeof reply.text === 'string' ? reply.text : '[图片或非文本消息]') : '';
  const maxBubbleWidth = width - 102;
  const desiredTextWidth = widestLine(sourceLines, fontSize);
  const desiredQuoteWidth = reply ? Math.max(widestLine([replyTitle], 16), widestLine([replyText], 15)) + 46 : 0;
  // The prototype keeps a quoted message at 300px where the viewport permits it.
  // Its right-side arrow and horizontal padding leave 46px less usable text width.
  const bubbleWidth = Math.ceil(Math.min(maxBubbleWidth, Math.max(118, desiredTextWidth + 26, desiredQuoteWidth, reply ? 324 : 0)));
  const visualLines = sourceLines.flatMap((line) => wrapSvgText(line, bubbleWidth - 26, fontSize));
  const quoteTextWidth = bubbleWidth - 46;
  const quoteTitleLines = reply ? wrapSvgText(replyTitle, quoteTextWidth, 16) : [];
  const quoteLines = reply ? wrapSvgText(replyText, quoteTextWidth, 15) : [];
  const lineHeight = compact ? 21 : 25;
  const quoteHeight = reply ? 29 + Math.max(0, quoteTitleLines.length - 1 + quoteLines.length) * 17 : 0;
  const images = imageSources(message);
  const imageHeight = images.length ? Math.min(2, images.length) * (compact ? 64 : 84) : 0;
  const x = out ? width - 66 - bubbleWidth : 76;
  const bubbleY = y + 24;
  const bubbleHeight = 24 + quoteHeight + visualLines.length * lineHeight + imageHeight;
  const avatarX = out ? width - 65 : 15;
  const nameX = out ? x + bubbleWidth : 76;
  const anchor = out ? 'end' : 'start';
  const seed = `${text(message.qq)}-${text(message.nickname)}`;
  const parts = [
    `<circle cx="${avatarX + 25}" cy="${y + 25}" r="25" fill="hsl(${hue(seed)} 62% 52%)"/>`,
    `<text x="${avatarX + 25}" y="${y + 31}" fill="#fff" font-size="17" font-weight="700" text-anchor="middle">${escapeXml(avatarLabel(message))}</text>`,
    `<rect x="${x}" y="${bubbleY}" width="${bubbleWidth}" height="${bubbleHeight}" rx="15" fill="${out ? palette.outbound : palette.inbound}"/>`,
  ];
  const role = roleInfo(message.role);
  if (role && !out) {
    const roleWidth = role.label.length * 14 + 14;
    parts.push(`<rect x="${nameX}" y="${y}" width="${roleWidth}" height="23" rx="6" fill="${role.color}"/>`, `<text x="${nameX + 7}" y="${y + 16}" fill="#fff" font-size="13">${role.label}</text>`, `<text x="${nameX + roleWidth + 7}" y="${y + 17}" fill="${palette.muted}" font-size="17">${escapeXml(text(message.nickname, '未命名用户'))}</text>`);
  } else parts.push(`<text x="${nameX}" y="${y + 17}" fill="${palette.muted}" font-size="17" text-anchor="${anchor}">${escapeXml(text(message.nickname, '未命名用户'))}</text>`);
  const frozenAvatar = safeVisualSource(message.avatarPath ?? message.avatarData);
  if (frozenAvatar) parts.push(`<image href="${escapeXml(frozenAvatar)}" x="${avatarX}" y="${y}" width="50" height="50" preserveAspectRatio="xMidYMid slice" clip-path="circle(25px at 25px 25px)"/>`);
  let textY = bubbleY + 23;
  if (reply) {
    const quoteX = x + 12, quoteY = bubbleY + 12, quoteWidth = bubbleWidth - 24;
    parts.push(`<rect x="${quoteX}" y="${quoteY}" width="${quoteWidth}" height="${quoteHeight - 4}" rx="6" fill="${palette.quote}"/>`);
    quoteTitleLines.forEach((line, index) => parts.push(`<text x="${quoteX + 11}" y="${quoteY + 18 + index * 17}" fill="${palette.text}" font-size="16" xml:space="preserve">${escapeXml(line)}</text>`));
    quoteLines.forEach((line, index) => parts.push(`<text x="${quoteX + 11}" y="${quoteY + 18 + quoteTitleLines.length * 17 + index * 17}" fill="${palette.quoteText}" font-size="15" xml:space="preserve">${escapeXml(line)}</text>`));
    parts.push(`<path d="M ${quoteX + quoteWidth - 24} ${quoteY + 16} h 17 m -8 -8 l 8 8 l -8 8" fill="none" stroke="${palette.text}" stroke-width="2"/>`);
    textY += quoteHeight;
  }
  visualLines.forEach((line, index) => parts.push(`<text x="${x + 13}" y="${textY + index * lineHeight}" fill="${palette.text}" font-size="${fontSize}" xml:space="preserve">${escapeXml(line)}</text>`));
  images.slice(0, 2).forEach((source, index) => parts.push(`<image href="${escapeXml(source)}" x="${x + 13}" y="${textY + visualLines.length * lineHeight + index * (compact ? 64 : 84)}" width="${Math.min(bubbleWidth - 26, compact ? 96 : 132)}" height="${compact ? 56 : 76}" preserveAspectRatio="xMidYMid meet"/>`));
  return { markup: parts.join(''), height: Math.max(68, bubbleHeight + 42) };
}

function renderSettings(options: RenderOptions) { const theme = options.theme ?? 'light'; const style = options.style ?? 'comfortable'; if (!(theme in themes)) throw new Error(`Unsupported report theme: ${theme}`); if (!['comfortable', 'compact'].includes(style)) throw new Error(`Unsupported report style: ${style}`); return { theme, style, palette: themes[theme], compact: style === 'compact' }; }

export function renderSvg(transcript: any, options: RenderOptions = {}): string {
  const { palette, compact } = renderSettings(options);
  const width = 540, conversation = isRecord(transcript?.conversation) ? transcript.conversation : {};
  const memberNames = Array.isArray(conversation.members) ? (conversation.members.filter(isRecord) as RecordValue[]).map((member: RecordValue) => text(member.nickname, text(member.qq))).filter(Boolean).slice(0, 8) : [];
  const memberLine = options.showMembers && conversation.kind !== 'private' && memberNames.length ? `成员：${memberNames.join('、')}` : '';
  const headerHeight = memberLine ? 86 : 62;
  let y = headerHeight + 15;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="100" viewBox="0 0 ${width} 100" font-family="${reportFontFamily}">`,
    `<rect width="100%" height="100%" fill="${palette.page}"/>`, `<rect width="100%" height="${headerHeight}" fill="${palette.header}"/>`,
    `<path d="M 31 31 l 10 -10 m -10 10 l 10 10" fill="none" stroke="${palette.text}" stroke-width="2"/>`,
    `<text x="58" y="39" fill="${palette.text}" font-size="21">${escapeXml(text(conversation.name, text(transcript?.title, 'QQ 消息预览')))}</text>`,
    `<path d="M 501 23 h 22 m -22 8 h 22 m -22 8 h 22" fill="none" stroke="${palette.text}" stroke-width="2"/>`,
  ];
  if (memberLine) parts.push(`<text x="58" y="66" fill="${palette.muted}" font-size="14">${escapeXml(memberLine)}</text>`);
  let previous: RecordValue | null = null;
  for (const message of messages(transcript)) {
    if (needsTimeDivider(previous, message)) { parts.push(`<text x="${width / 2}" y="${y + 17}" fill="${palette.muted}" font-size="16" text-anchor="middle">${escapeXml(readableTime(message.timestamp))}</text>`); y += 42; }
    const bubble = svgBubble(message, y, width, palette, compact); parts.push(bubble.markup); y += bubble.height; previous = message;
  }
  const height = Math.max(120, y + 20); parts[0] = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${reportFontFamily}">`; parts.push('</svg>'); return parts.join('');
}

export function renderHtml(transcript: any, options: RenderOptions = {}): string {
  const { theme, style } = renderSettings(options);
  const serialized = JSON.stringify(transcript).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="zh-CN" data-theme="${theme}" data-style="${style}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QQ 消息预览</title><style>body{margin:0;padding:24px;background:#edf1f6;font-family:${reportFontCss}}main{max-width:520px;margin:auto;box-shadow:0 16px 40px #24325220}svg{display:block;width:100%;height:auto}details{max-width:520px;margin:18px auto;color:#526077}pre{overflow:auto;padding:12px;background:#fff;border-radius:8px;font-size:12px}</style><main>${renderSvg(transcript, options)}</main><details><summary>查看 transcript</summary><pre>${escapeXml(JSON.stringify(transcript, null, 2))}</pre></details><script type="application/json" id="transcript">${serialized}</scr${'ipt'}></html>`;
}
