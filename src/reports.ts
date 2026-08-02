import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveIdentities } from './identity.ts';
import { rasterizeSvgToPng, type PngExporter } from './png.ts';
import { renderHtml, renderSvg, type RenderOptions } from './renderer.ts';

function safeReportName(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Invalid scenario report name: ${value}`);
  return value;
}

function inlineImage(value: unknown) {
  return typeof value === 'string' ? value.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/) : null;
}

/** Keep user-controlled transcript values from becoming report path segments. */
function assetToken(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (/^[A-Za-z0-9_-]+$/u.test(text) && text !== '.' && text !== '..') return text;
  return `${fallback}-${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)}`;
}

export async function writeScenarioReport({ projectRoot, name, transcript, offline = false, refreshIdentities = false, theme, style, showMembers, png = false, pngExporter = rasterizeSvgToPng }: { projectRoot: string; name: string; transcript: any; offline?: boolean; refreshIdentities?: boolean; png?: boolean; pngExporter?: PngExporter } & RenderOptions) {
  const reportName = safeReportName(name);
  const directory = join(projectRoot, '.seal', 'reports');
  await mkdir(directory, { recursive: true });
  const resolved = await resolveIdentities({ projectRoot, transcript, offline, refresh: refreshIdentities });
  const json = join(directory, `${reportName}.transcript.json`);
  const svg = join(directory, `${reportName}.svg`);
  const html = join(directory, `${reportName}.html`);
  const pngPath = png ? join(directory, `${reportName}.png`) : undefined;
  const identities = join(directory, `${reportName}.identities.json`);
  const avatarDirectory = join(directory, `${reportName}.avatars`);
  const assetDirectory = join(directory, `${reportName}.assets`);
  const avatarFiles: Record<string, string> = Object.create(null) as Record<string, string>;
  const assetPaths = new Set<string>();
  const messages = Array.isArray(resolved.transcript.messages) ? resolved.transcript.messages : [];
  for (const [messageIndex, message] of messages.entries()) {
    const qq = typeof message?.qq === 'string' ? message.qq : '';
    const avatar = inlineImage(message?.avatarData);
    if (!qq || !avatar || avatarFiles[qq]) continue;
    const extension = avatar[1] === 'image/jpeg' ? 'jpg' : avatar[1].slice('image/'.length);
    const relative = `${reportName}.avatars/${assetToken(qq, `avatar-${messageIndex + 1}`)}.${extension}`;
    await mkdir(avatarDirectory, { recursive: true });
    await writeFile(join(directory, relative), Buffer.from(avatar[2], 'base64'), { mode: 0o600 });
    avatarFiles[qq] = relative;
  }
  for (const message of messages) {
    if (avatarFiles[message?.qq]) {
      message.avatarPath = avatarFiles[message.qq];
      delete message.avatarData;
    }
  }
  for (const [messageIndex, message] of messages.entries()) {
    if (!Array.isArray(message?.segments)) continue;
    const sequence = assetToken(Number.isInteger(message.sequence) ? message.sequence : messageIndex + 1, `message-${messageIndex + 1}`);
    for (const [index, segment] of message.segments.entries()) {
      if (!segment || typeof segment !== 'object' || segment.type !== 'image') continue;
      const image = inlineImage(segment.data ?? segment.dataUrl);
      if (!image) continue;
      const extension = image[1] === 'image/jpeg' ? 'jpg' : image[1].slice('image/'.length);
      const base = `${reportName}.assets/message-${sequence}-${index + 1}`;
      let relative = `${base}.${extension}`;
      if (assetPaths.has(relative)) relative = `${base}-${messageIndex + 1}.${extension}`;
      assetPaths.add(relative);
      await mkdir(assetDirectory, { recursive: true });
      await writeFile(join(directory, relative), Buffer.from(image[2], 'base64'), { mode: 0o600 });
      segment.assetPath = relative;
      delete segment.data;
      delete segment.dataUrl;
    }
  }
  // All report formats must be derived from the same frozen transcript.  The
  // identity pass above replaces inline avatars/images with relative asset
  // paths, so writing the caller's original transcript here would leave the
  // JSON export disagreeing with the SVG/HTML exports (and could retain data
  // URIs that are supposed to be frozen as files).
  const exportedTranscript = resolved.transcript;
  const svgMarkup = renderSvg(exportedTranscript, { theme, style, showMembers });
  await Promise.all([
    writeFile(json, `${JSON.stringify(exportedTranscript, null, 2)}\n`, { mode: 0o600 }),
    writeFile(svg, svgMarkup, { mode: 0o600 }),
    writeFile(html, renderHtml(exportedTranscript, { theme, style, showMembers }), { mode: 0o600 }),
    writeFile(identities, `${JSON.stringify({ identities: resolved.identities, avatarFiles, warnings: resolved.warnings, provider: resolved.provider }, null, 2)}\n`, { mode: 0o600 }),
  ]);
  if (pngPath) await pngExporter({ svg, png: pngPath });
  return { json, svg, html, png: pngPath, identities, warnings: resolved.warnings };
}
