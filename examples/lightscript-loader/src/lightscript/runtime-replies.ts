import { describeError } from './diagnostics';
import type { DiagnosticReporter } from './types';

interface StorageAdapter {
  storageGet(key: string): string;
  storageSet(key: string, value: string): void;
}

interface PersistedRuntimeReplies {
  replies: RuntimeReply[];
  version: 1;
}

export type RuntimeReply =
  | { keyword: string; text: string; program?: never }
  | { keyword: string; program: string; text?: never };

export type RuntimeReplyMutation =
  | { kind: 'added' | 'removed' | 'updated' }
  | { kind: 'invalid' | 'missing' | 'storage-failed'; message: string };

export const maxRuntimeReplies = 100;
export const maxRuntimeReplyKeywordCharacters = 128;
export const maxRuntimeReplyTextCharacters = 2_000;
export const maxRuntimeReplyProgramCharacters = 8_000;

const storageKey = 'sealdice-lightscript-runtime-replies-v1';

function validReply(value: unknown): value is RuntimeReply {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  const text = typeof candidate['text'] === 'string';
  const program = typeof candidate['program'] === 'string';
  return typeof candidate['keyword'] === 'string' && text !== program;
}

function parseState(raw: string): RuntimeReply[] | null {
  if (raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return null;
    const candidate = parsed as Record<string, unknown>;
    if (candidate['version'] !== 1 || !Array.isArray(candidate['replies']))
      return null;
    if (!candidate['replies'].every(validReply)) return null;
    return candidate['replies'].map((reply) => ({ ...reply }));
  } catch {
    return null;
  }
}

function validateReply(
  keyword: string,
  content: string,
  label: string,
  maximum: number,
): string | null {
  if (keyword === '') return '关键词不能为空。';
  if (/\r|\n/u.test(keyword)) return '关键词不能包含换行。';
  if (keyword.length > maxRuntimeReplyKeywordCharacters)
    return `关键词最多 ${String(maxRuntimeReplyKeywordCharacters)} 个字符。`;
  if (content === '') return `${label}不能为空。`;
  if (content.length > maximum)
    return `${label}最多 ${String(maximum)} 个字符。`;
  return null;
}

/** Persistent exact-match replies created through the restricted .回雪 command. */
export class RuntimeReplyStore {
  private replies: RuntimeReply[] | undefined;

  public constructor(
    private readonly extension: StorageAdapter,
    private readonly reporter: DiagnosticReporter,
  ) {}

  private current(): RuntimeReply[] {
    if (this.replies !== undefined) return this.replies;
    let raw = '';
    try {
      raw = this.extension.storageGet(storageKey);
    } catch (error) {
      this.reporter.report({
        code: 'runtime-replies-storage-read-failed',
        message: describeError(error),
        severity: 'warning',
      });
    }
    const parsed = parseState(raw);
    if (parsed === null) {
      this.reporter.report({
        code: 'invalid-runtime-replies-storage',
        message: 'Persisted runtime replies are invalid and were ignored',
        severity: 'warning',
      });
      this.replies = [];
    } else {
      this.replies = parsed;
    }
    return this.replies;
  }

  private save(): boolean {
    const state: PersistedRuntimeReplies = {
      replies: this.current(),
      version: 1,
    };
    try {
      this.extension.storageSet(storageKey, JSON.stringify(state));
      return true;
    } catch (error) {
      this.reporter.report({
        code: 'runtime-replies-storage-write-failed',
        message: describeError(error),
        severity: 'error',
      });
      return false;
    }
  }

  public all(): readonly RuntimeReply[] {
    return this.current().map((reply) => ({ ...reply }));
  }

  public find(message: string): RuntimeReply | undefined {
    const reply = this.current().find(
      (candidate) => candidate.keyword === message,
    );
    return reply === undefined ? undefined : { ...reply };
  }

  private upsertEntry(
    keyword: string,
    reply: RuntimeReply,
    content: string,
    label: string,
    maximum: number,
  ): RuntimeReplyMutation {
    const issue = validateReply(keyword, content, label, maximum);
    if (issue !== null) return { kind: 'invalid', message: issue };
    const replies = this.current();
    const index = replies.findIndex((reply) => reply.keyword === keyword);
    if (index === -1 && replies.length >= maxRuntimeReplies) {
      return {
        kind: 'invalid',
        message: `运行时回复最多 ${String(maxRuntimeReplies)} 条。`,
      };
    }
    const mutation = index === -1 ? 'added' : 'updated';
    if (index === -1) replies.push(reply);
    else replies[index] = reply;
    return this.save()
      ? { kind: mutation }
      : { kind: 'storage-failed', message: '保存运行时回复失败。' };
  }

  public upsert(keyword: string, text: string): RuntimeReplyMutation {
    return this.upsertEntry(
      keyword,
      { keyword, text },
      text,
      '回复文本',
      maxRuntimeReplyTextCharacters,
    );
  }

  /** Stores a LightScript program that runs only for this exact keyword. */
  public upsertProgram(keyword: string, program: string): RuntimeReplyMutation {
    return this.upsertEntry(
      keyword,
      { keyword, program },
      program,
      '回雪代码',
      maxRuntimeReplyProgramCharacters,
    );
  }

  public remove(keyword: string): RuntimeReplyMutation {
    const replies = this.current();
    const index = replies.findIndex((reply) => reply.keyword === keyword);
    if (index === -1) return { kind: 'missing', message: '未找到该关键词。' };
    replies.splice(index, 1);
    return this.save()
      ? { kind: 'removed' }
      : { kind: 'storage-failed', message: '保存运行时回复失败。' };
  }
}

export function splitRuntimeReplyDefinition(
  source: string,
): { keyword: string; text: string } | null {
  const separator = source.indexOf('|');
  if (separator === -1) return null;
  return {
    keyword: source.slice(0, separator).trim(),
    text: source.slice(separator + 1).trim(),
  };
}
