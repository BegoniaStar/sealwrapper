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
  const avatarFiles: Record<string, string> = {};
  const messages = Array.isArray(resolved.transcript.messages) ? resolved.transcript.messages : [];
  for (const message of messages) {
    const qq = typeof message?.qq === 'string' ? message.qq : '';
    const avatar = inlineImage(message?.avatarData);
    if (!qq || !avatar || avatarFiles[qq]) continue;
    const extension = avatar[1] === 'image/jpeg' ? 'jpg' : avatar[1].slice('image/'.length);
    const relative = `${reportName}.avatars/${qq}.${extension}`;
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
  for (const message of messages) {
    if (!Array.isArray(message?.segments)) continue;
    const sequence = Number.isInteger(message.sequence) ? message.sequence : 0;
    for (const [index, segment] of message.segments.entries()) {
      if (!segment || typeof segment !== 'object' || segment.type !== 'image') continue;
      const image = inlineImage(segment.data ?? segment.dataUrl);
      if (!image) continue;
      const extension = image[1] === 'image/jpeg' ? 'jpg' : image[1].slice('image/'.length);
      const relative = `${reportName}.assets/message-${sequence}-${index + 1}.${extension}`;
      await mkdir(assetDirectory, { recursive: true });
      await writeFile(join(directory, relative), Buffer.from(image[2], 'base64'), { mode: 0o600 });
      segment.assetPath = relative;
      delete segment.data;
      delete segment.dataUrl;
    }
  }
  const svgMarkup = renderSvg(resolved.transcript, { theme, style, showMembers });
  await Promise.all([
    writeFile(json, `${JSON.stringify(transcript, null, 2)}\n`, { mode: 0o600 }),
    writeFile(svg, svgMarkup, { mode: 0o600 }),
    writeFile(html, renderHtml(resolved.transcript, { theme, style, showMembers }), { mode: 0o600 }),
    writeFile(identities, `${JSON.stringify({ identities: resolved.identities, avatarFiles, warnings: resolved.warnings, provider: resolved.provider }, null, 2)}\n`, { mode: 0o600 }),
  ]);
  if (pngPath) await pngExporter({ svg, png: pngPath });
  return { json, svg, html, png: pngPath, identities, warnings: resolved.warnings };
}
