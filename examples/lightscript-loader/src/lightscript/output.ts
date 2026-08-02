import { getJrrp, type LibEnvironment } from './lib';
import type { OutputContext } from './types';

function isQqLike(platform: string): boolean {
  return /onebot|qq/iu.test(platform);
}

function outputText(
  value: string,
  context: OutputContext,
  jrrp: number,
): string {
  const qq = isQqLike(context.platform);
  return value
    .replace(/<?#\{AT-([^}]+)\}>?/gu, (_whole, id: string) =>
      qq ? `[CQ:at,qq=${id}]` : `@${id}`,
    )
    .replace(/#\{PICTURE-([^}]+)\}/gu, (_whole, url: string) =>
      qq ? `[CQ:image,file=${url}]` : `图片：${url}`,
    )
    .replace(/#\{JRRP-\}/gu, String(jrrp))
    .replace(/\{user\}/gu, context.userName)
    .replace(/\{player\}/gu, context.playerName);
}

export function renderOutput(
  value: string,
  context: OutputContext,
  libEnvironment: LibEnvironment,
): readonly string[] {
  const jrrp = getJrrp(libEnvironment);
  return value
    .split(/#\{(?:MULT|SPLIT)\}/u)
    .map((part) => outputText(part, context, jrrp).trim())
    .filter((part) => part !== '');
}
