import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const cacheTTLMilliseconds = 7 * 24 * 60 * 60 * 1000;
const requestTimeoutMilliseconds = 5_000;
const requestSpacingMilliseconds = 250;
const maxAvatarBytes = 2 * 1024 * 1024;
const maxNicknameCharacters = 512;
const qqPattern = /^[1-9]\d{4,11}$/;
const avatarContentTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const cacheTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

type CacheEntry = { qq: string; nickname?: string; avatarBase64?: string; avatarContentType?: string; fetchedAt: string; provider: 'qq-public' };

function clone<T>(value: T): T { return structuredClone(value); }

function validAvatarBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !base64Pattern.test(value)) return false;
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.length > 0 && bytes.length <= maxAvatarBytes && bytes.toString('base64') === value;
  } catch { return false; }
}

/**
 * Validate cache data before it can influence a report.  Cache files are
 * user-writable JSON, so checking only `qq` (the old behaviour) allowed
 * malformed timestamps, arbitrary content types, and oversized/non-canonical
 * base64 data to flow into the renderer.
 */
function validateCacheEntry(value: unknown, expectedQq: string): CacheEntry | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const allowed = new Set(['qq', 'nickname', 'avatarBase64', 'avatarContentType', 'fetchedAt', 'provider']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
  if (raw.qq !== expectedQq || typeof raw.qq !== 'string' || !qqPattern.test(raw.qq)) return null;
  if (raw.provider !== 'qq-public') return null;
  if (typeof raw.fetchedAt !== 'string' || !cacheTimestampPattern.test(raw.fetchedAt) || !Number.isFinite(Date.parse(raw.fetchedAt))) return null;
  if (raw.nickname !== undefined && (typeof raw.nickname !== 'string' || raw.nickname.length > maxNicknameCharacters)) return null;
  const hasBase64 = raw.avatarBase64 !== undefined;
  const hasContentType = raw.avatarContentType !== undefined;
  if (hasBase64 !== hasContentType) return null;
  if (hasBase64 && !validAvatarBase64(raw.avatarBase64)) return null;
  let avatarContentType: string | undefined;
  if (hasContentType) {
    if (typeof raw.avatarContentType !== 'string') return null;
    avatarContentType = raw.avatarContentType.toLowerCase();
    if (!avatarContentTypes.has(avatarContentType)) return null;
  }
  return {
    qq: raw.qq,
    ...(raw.nickname !== undefined ? { nickname: raw.nickname } : {}),
    ...(hasBase64 ? { avatarBase64: raw.avatarBase64 as string } : {}),
    ...(avatarContentType ? { avatarContentType } : {}),
    fetchedAt: raw.fetchedAt,
    provider: 'qq-public',
  };
}

async function cacheEntry(directory: string, qq: string): Promise<CacheEntry | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(directory, `${qq}.json`), 'utf8'));
    return validateCacheEntry(parsed, qq);
  } catch { return null; }
}

function fresh(entry: CacheEntry | null): entry is CacheEntry {
  if (!entry) return false;
  const age = Date.now() - Date.parse(entry.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < cacheTTLMilliseconds;
}

function dataUri(entry: CacheEntry): string {
  return entry.avatarBase64 && entry.avatarContentType ? `data:${entry.avatarContentType};base64,${entry.avatarBase64}` : '';
}

function charsetFrom(contentType: string | null): string {
  return contentType?.match(/(?:^|;)\s*charset\s*=\s*([^;\s]+)/i)?.[1]?.replaceAll('"', '').toLowerCase() ?? '';
}

/**
 * QQ's portrait endpoint has historically returned GBK/GB18030 bytes, even
 * when an intermediary omits or mislabels the charset.  `Response.text()`
 * always assumes UTF-8 and therefore turns real public nicknames into U+FFFD
 * before we can recover them.  Keep the raw bytes until the endpoint-specific
 * decoding decision is made.
 */
async function responsePortraitText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMilliseconds), headers: { accept: 'text/plain, application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const charset = charsetFrom(response.headers.get('content-type'));
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if (/^(?:gbk|gb2312|gb18030|gb_?18030)$/i.test(charset) || utf8.includes('\ufffd')) return new TextDecoder('gb18030').decode(bytes);
  return utf8;
}

async function responseAvatar(url: string): Promise<{ contentType: string; base64: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMilliseconds), headers: { accept: 'image/*' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!avatarContentTypes.has(contentType)) throw new Error(`unexpected avatar content type ${contentType || 'missing'}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maxAvatarBytes) throw new Error('avatar response size is invalid');
  return { contentType, base64: bytes.toString('base64') };
}

function publicNickname(body: string, qq: string): string {
  const match = body.match(/portraitCallBack\s*\(\s*(\{[\s\S]*\})\s*\)\s*;?\s*$/);
  if (!match) throw new Error('QQ portrait response did not contain portraitCallBack JSON');
  const record = JSON.parse(match[1]);
  const value = record?.[qq];
  if (!Array.isArray(value)) throw new Error('QQ portrait response did not contain a public nickname');
  // The public users.qzone endpoint uses index 0 for a legacy avatar URL and
  // index 6 for the nickname. Older portrait responses put the nickname at 0.
  const nickname = [value[6], value[0]].find((candidate) => typeof candidate === 'string' && candidate.trim() && !/^https?:\/\//i.test(candidate));
  if (typeof nickname !== 'string') throw new Error('QQ portrait response did not contain a public nickname');
  if (nickname.length > maxNicknameCharacters) throw new Error('QQ portrait nickname is too long');
  return nickname;
}

async function fetchPublicIdentity(qq: string): Promise<CacheEntry> {
  // Both endpoints are operated by QQ. No third-party identity aggregation is used.
  // `r.qzone.qq.com` now commonly requires an authenticated Qzone session. The
  // public `users.qzone.qq.com` portrait endpoint remains usable without one.
  const nicknameURL = `https://users.qzone.qq.com/fcg-bin/cgi_get_portrait.fcg?uins=${encodeURIComponent(qq)}`;
  const avatarURL = `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(qq)}&s=640`;
  // Keep the two public lookups independent in both directions.  A transient
  // qlogo failure should not discard a successfully resolved nickname, just as
  // a nickname endpoint failure must not discard a usable avatar.
  const [avatarResult, nicknameResult] = await Promise.allSettled([
    responseAvatar(avatarURL),
    responsePortraitText(nicknameURL).then((body) => publicNickname(body, qq)),
  ]);
  const avatar = avatarResult.status === 'fulfilled' ? avatarResult.value : undefined;
  const nickname = nicknameResult.status === 'fulfilled' ? nicknameResult.value : undefined;
  if (!avatar && !nickname) {
    const avatarError = avatarResult.status === 'rejected' ? (avatarResult.reason as Error)?.message : 'unavailable';
    const nicknameError = nicknameResult.status === 'rejected' ? (nicknameResult.reason as Error)?.message : 'unavailable';
    throw new Error(`public identity endpoints failed (avatar: ${avatarError}; nickname: ${nicknameError})`);
  }
  return {
    qq,
    ...(nickname ? { nickname } : {}),
    ...(avatar ? { avatarBase64: avatar.base64, avatarContentType: avatar.contentType } : {}),
    fetchedAt: new Date().toISOString(),
    provider: 'qq-public',
  };
}

function fallback(message: any, qq: string) {
  return { ...message, qq, identitySource: message.nickname ? 'scenario' : 'placeholder' };
}

export async function resolveIdentities({ projectRoot, transcript, offline = false, refresh = false }: { projectRoot: string; transcript: any; offline?: boolean; refresh?: boolean }) {
  const cacheDirectory = join(projectRoot, '.seal', 'identity-cache');
  await mkdir(cacheDirectory, { recursive: true });
  const result = clone(transcript);
  const warnings: string[] = [];
  const identities: Record<string, any> = {};
  const messages = Array.isArray(result.messages) ? result.messages : [];
  const seen = new Map<string, { entry: CacheEntry | null; source: 'qq-public' | 'cache' }>();
  for (const message of messages) {
    const qq = typeof message?.qq === 'string' ? message.qq : '';
    if (!qqPattern.test(qq)) {
      Object.assign(message, fallback(message, qq));
      warnings.push(qq ? `QQ ${qq} is not a valid public QQ number` : 'message has no QQ number');
      continue;
    }
    let entry: CacheEntry | null;
    let source: 'qq-public' | 'cache' | 'scenario' | 'placeholder' = 'cache';
    const previous = seen.get(qq);
    if (previous) {
      entry = previous.entry;
      source = previous.source;
    } else {
      entry = await cacheEntry(cacheDirectory, qq);
      if (refresh || !fresh(entry)) {
        if (offline) {
          warnings.push(entry ? `offline identity cache is stale for QQ ${qq}` : `offline identity cache miss for QQ ${qq}`);
        } else {
          try {
            entry = await fetchPublicIdentity(qq);
            await writeFile(join(cacheDirectory, `${qq}.json`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
            source = 'qq-public';
            if (!entry.avatarBase64) warnings.push(`QQ public avatar lookup unavailable for ${qq}`);
            if (!entry.nickname) warnings.push(`QQ public nickname lookup unavailable for ${qq}`);
          } catch (error) {
            warnings.push(`QQ public identity lookup failed for ${qq}: ${(error as Error).message}`);
          }
          await new Promise((resolve) => setTimeout(resolve, requestSpacingMilliseconds));
        }
      }
      seen.set(qq, { entry: entry ?? null, source: source === 'qq-public' ? 'qq-public' : 'cache' });
    }
    if (entry) {
      if (source !== 'qq-public') source = 'cache';
      // Scenario/transcript nickname is the chat identity chosen by the author.
      // QQ's public nickname is only a fallback when that field is absent.
      message.nickname = message.nickname || entry.nickname || '未命名用户';
      message.identitySource = source;
      const avatar = dataUri(entry);
      if (avatar) message.avatarData = avatar;
      identities[qq] = { qq, nickname: message.nickname, identitySource: source, fetchedAt: entry.fetchedAt, avatarContentType: entry.avatarContentType ?? null };
    } else {
      Object.assign(message, fallback(message, qq));
      identities[qq] = { qq, nickname: message.nickname || null, identitySource: message.identitySource };
    }
  }
  return { transcript: result, identities, warnings, provider: { id: 'qq-public', nicknameEndpoint: 'https://users.qzone.qq.com/fcg-bin/cgi_get_portrait.fcg?uins=<qq>', avatarEndpoint: 'https://q1.qlogo.cn/g?b=qq&nk=<qq>&s=640', timeoutMilliseconds: requestTimeoutMilliseconds, spacingMilliseconds: requestSpacingMilliseconds, cacheTTLMilliseconds } };
}
