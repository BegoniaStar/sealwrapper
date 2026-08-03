// schema-v2 generates the sealpack manifest from seal.config.json, so the
// runtime metadata stays here rather than reviving the legacy extension.json.
const extensionMetadata = {
  id: 'sealdice-lightscript-loader',
  author: 'BegoniaHe',
  version: '1.0.0',
} as const;

import {
  formatRuntimeTomlParse,
  isManagementAllowed,
  maxRuntimeTomlCharacters,
  parseRuntimeToml,
  sourceAfterSubcommand,
} from './lightscript/admin';
import {
  DiagnosticCollector,
  describeError,
  logDiagnostic,
} from './lightscript/diagnostics';
import {
  LightScriptEvaluator,
  outputFromContent,
  type EvaluationEnvironment,
} from './lightscript/evaluator';
import { type LibEnvironment } from './lightscript/lib';
import { renderOutput } from './lightscript/output';
import { loadRuntimeDocumentSet } from './lightscript/package-loader';
import {
  RuntimeReplyStore,
  splitRuntimeReplyDefinition,
} from './lightscript/runtime-replies';
import { matchDocuments } from './lightscript/trigger';
import type {
  LightScriptAuto,
  LightScriptDocument,
  LightScriptHost,
  MessageIdentity,
  OutputContext,
} from './lightscript/types';
import { SolidStateStore, VariableService } from './lightscript/variables';

const managementConfigGroup = '回雪管理';
const managementEnabledConfigKey = 'lightscript.management.enabled';
const managementWhitelistConfigKey = 'lightscript.management.whitelist';
const managementCommandHelp = `回雪管理（仅骰主或白名单，且须在扩展配置中启用）：
.回雪 解析\n<完整 TOML>  只解析并报告，不执行脚本
.回雪 运行 <回雪代码>
.回雪 添加 <关键词> | <回复文本>
.回雪 添加代码 <关键词> | <回雪代码>
.回雪 删除 <关键词>
.回雪 列表
.回雪 状态`;

const runtimeReplyDocument: LightScriptDocument = {
  autos: [],
  defines: {},
  file: 'runtime-replies',
  id: 'runtime-replies',
  root: {},
  sequence: Number.MAX_SAFE_INTEGER,
};

const runtimeDebugDocument: LightScriptDocument = {
  autos: [],
  defines: {},
  file: 'runtime-debug',
  id: 'runtime-debug',
  root: {},
  sequence: Number.MAX_SAFE_INTEGER - 1,
};

class DocumentRuntime {
  private readonly lastSendTimeByUser = new Map<string, number>();

  private variablesInstance: VariableService | undefined;

  public constructor(
    private readonly document: LightScriptDocument,
    private readonly storage: SolidStateStore,
    private readonly now: () => number,
  ) {}

  public get variables(): VariableService {
    this.variablesInstance ??= new VariableService(
      this.document.id,
      this.storage,
      this.now,
    );
    return this.variablesInstance;
  }

  public lastActivatedAt(senderId: string): number {
    return this.lastSendTimeByUser.get(senderId) ?? 0;
  }

  public markSent(senderId: string, now: number): void {
    this.lastSendTimeByUser.set(senderId, now);
  }
}

function identityFor(ctx: seal.MsgContext, msg: seal.Message): MessageIdentity {
  const senderId = msg.sender.userId;
  const userName = msg.sender.nickname === '' ? senderId : msg.sender.nickname;
  const playerName =
    ctx.player?.name === undefined || ctx.player.name === ''
      ? userName
      : ctx.player.name;
  const groupId = ctx.group?.groupId ?? '';
  return { groupId, playerName, senderId, userName };
}

function outputContext(
  identity: MessageIdentity,
  msg: seal.Message,
): OutputContext {
  return {
    groupId: identity.groupId,
    platform: msg.platform,
    playerName: identity.playerName,
    senderId: identity.senderId,
    userName: identity.userName,
  };
}

function registerManagementConfig(extension: seal.ExtInfo): void {
  seal.ext.registerBoolConfig(
    extension,
    managementEnabledConfigKey,
    false,
    '启用 .回雪 管理命令；默认关闭。',
    managementConfigGroup,
  );
  seal.ext.registerStringConfig(
    extension,
    managementWhitelistConfigKey,
    '',
    '允许使用 .回雪 的白名单。用逗号、空格或换行分隔完整用户 ID；QQ 可填写 QQ:123 或 123。骰主始终允许。',
    managementConfigGroup,
  );
}

function managementIsEnabled(extension: seal.ExtInfo): boolean {
  return seal.ext.getBoolConfig(extension, managementEnabledConfigKey);
}

function managementUserIsAllowed(
  extension: seal.ExtInfo,
  ctx: seal.MsgContext,
  msg: seal.Message,
): boolean {
  return isManagementAllowed(
    ctx.privilegeLevel,
    msg.sender.userId,
    seal.ext.getStringConfig(extension, managementWhitelistConfigKey),
  );
}

function documentCounts(documents: readonly LightScriptDocument[]): {
  autos: number;
  defines: number;
} {
  return documents.reduce(
    (counts, document) => ({
      autos: counts.autos + document.autos.length,
      defines: counts.defines + Object.keys(document.defines).length,
    }),
    { autos: 0, defines: 0 },
  );
}

function replyDirect(
  ctx: seal.MsgContext,
  msg: seal.Message,
  text: string,
): boolean {
  try {
    seal.replyToSender(ctx, msg, text);
    return true;
  } catch (error) {
    console.error(
      `[LightScript][error][management-reply-failed]: ${describeError(error)}`,
    );
    return false;
  }
}

function replyRuntimeText(
  ctx: seal.MsgContext,
  msg: seal.Message,
  identity: MessageIdentity,
  text: string,
  reporter: DiagnosticCollector,
  variables: VariableService,
): void {
  const auto: LightScriptAuto = {
    content: text,
    fields: {},
    keywordContained: [],
    keywordFull: [],
    keywordRegexp: [],
    ordinal: 0,
  };
  const host: LightScriptHost = {
    context: ctx,
    message: msg,
    now: Date.now,
    random: Math.random,
    reply: () => false,
  };
  const environment: LibEnvironment = {
    address: { groupId: identity.groupId, senderId: identity.senderId },
    auto,
    document: runtimeReplyDocument,
    host,
    reporter,
    variables,
  };
  for (const output of renderOutput(
    text,
    outputContext(identity, msg),
    environment,
  ))
    replyDirect(ctx, msg, output);
}

/** Runs an explicitly-authorized debug snippet in an isolated document scope. */
function runRuntimeCode(
  ctx: seal.MsgContext,
  msg: seal.Message,
  identity: MessageIdentity,
  source: string,
  reporter: DiagnosticCollector,
  runtime: DocumentRuntime,
  options: { document: LightScriptDocument; announceEmpty: boolean } = {
    document: runtimeDebugDocument,
    announceEmpty: true,
  },
): void {
  const auto: LightScriptAuto = {
    fields: {},
    keywordContained: [],
    keywordFull: [],
    keywordRegexp: [],
    ordinal: 0,
    program: source,
  };
  const address = { groupId: identity.groupId, senderId: identity.senderId };
  const now = Date.now;
  const send = (text: string): boolean => {
    let sentNow = false;
    for (const output of renderOutput(
      text,
      outputContext(identity, msg),
      libEnvironment,
    )) {
      if (replyDirect(ctx, msg, output)) sentNow = true;
    }
    if (sentNow) runtime.markSent(identity.senderId, now());
    return sentNow;
  };
  const host: LightScriptHost = {
    context: ctx,
    message: msg,
    now,
    random: Math.random,
    reply: send,
  };
  const libEnvironment: LibEnvironment = {
    address,
    auto,
    document: options.document,
    host,
    reporter,
    variables: runtime.variables,
  };
  const result = new LightScriptEvaluator({
    ...libEnvironment,
    captures: [],
    lastActivatedAt: runtime.lastActivatedAt(identity.senderId),
  }).run();
  send(result.output);
  if (result.output === '' && options.announceEmpty)
    replyDirect(ctx, msg, '回雪：运行完成（无输出）。');
}

function main(): void {
  const existingExtension = seal.ext.find(extensionMetadata.id);
  const extension =
    existingExtension ??
    seal.ext.new(
      extensionMetadata.id,
      extensionMetadata.author,
      extensionMetadata.version,
    );
  if (existingExtension === null) seal.ext.register(extension);
  extension.autoActive = true;
  registerManagementConfig(extension);

  const diagnostics = new DiagnosticCollector();
  const loadedDocuments = loadRuntimeDocumentSet(diagnostics);
  const documents = loadedDocuments.documents;
  const storage = new SolidStateStore(extension, diagnostics);
  const runtimeReplies = new RuntimeReplyStore(extension, diagnostics);
  const runtimeReplyRuntime = new DocumentRuntime(
    runtimeReplyDocument,
    storage,
    Date.now,
  );
  const runtimeDebugRuntime = new DocumentRuntime(
    runtimeDebugDocument,
    storage,
    Date.now,
  );
  const runtimes = new Map<string, DocumentRuntime>();
  for (const document of documents)
    runtimes.set(document.id, new DocumentRuntime(document, storage, Date.now));

  let loggedDiagnostics = 0;
  const logNewDiagnostics = (): void => {
    const all = diagnostics.all();
    for (let index = loggedDiagnostics; index < all.length; index += 1) {
      const diagnostic = all[index];
      if (diagnostic !== undefined) logDiagnostic(diagnostic, console);
    }
    loggedDiagnostics = all.length;
  };
  const counts = documentCounts(documents);
  console.info(
    `[LightScript] load complete: packages=${String(
      documents.length,
    )}/${String(loadedDocuments.requested)} autos=${String(
      counts.autos,
    )} defines=${String(counts.defines)} ${diagnostics.summary()}`,
  );
  logNewDiagnostics();

  const command = seal.ext.newCmdItemInfo();
  command.name = '回雪';
  command.help = managementCommandHelp;
  command.helpFunc = null;
  command.allowDelegate = false;
  command.disabledInPrivate = false;
  command.enableExecuteTimesParse = false;
  command.raw = false;
  command.checkCurrentBotOn = true;
  command.checkMentionOthers = true;
  command.solve = (ctx, msg, cmdArgs): seal.CmdExecuteResult => {
    if (!managementUserIsAllowed(extension, ctx, msg))
      return seal.ext.newCmdExecuteResult(true);
    if (!managementIsEnabled(extension)) {
      replyDirect(
        ctx,
        msg,
        '回雪管理命令已关闭。请在扩展配置“回雪管理”中启用 lightscript.management.enabled。',
      );
      return seal.ext.newCmdExecuteResult(true);
    }

    const subcommand = cmdArgs.getArgN(1);
    if (subcommand === '状态') {
      const currentCounts = documentCounts(documents);
      replyDirect(
        ctx,
        msg,
        `回雪：内容包 ${String(documents.length)}，auto ${String(
          currentCounts.autos,
        )}，define ${String(currentCounts.defines)}，运行时回复 ${String(
          runtimeReplies.all().length,
        )}。${diagnostics.summary()}`,
      );
      logNewDiagnostics();
      return seal.ext.newCmdExecuteResult(true);
    }
    if (subcommand === '解析') {
      const source = sourceAfterSubcommand(cmdArgs.rawArgs, subcommand);
      if (source === null || source === '') {
        replyDirect(ctx, msg, '用法：.回雪 解析 后换行粘贴完整 TOML。');
        return seal.ext.newCmdExecuteResult(true);
      }
      if (source.length > maxRuntimeTomlCharacters) {
        replyDirect(
          ctx,
          msg,
          `回雪：调试 TOML 最多 ${String(maxRuntimeTomlCharacters)} 个字符。`,
        );
        return seal.ext.newCmdExecuteResult(true);
      }
      const result = parseRuntimeToml(source);
      console.info(
        `[LightScript][runtime-parse] sender=${msg.sender.userId} documents=${String(
          result.documents.length,
        )} diagnostics=${String(result.diagnostics.length)}`,
      );
      for (const diagnostic of result.diagnostics)
        logDiagnostic(diagnostic, console);
      replyDirect(ctx, msg, formatRuntimeTomlParse(result));
      return seal.ext.newCmdExecuteResult(true);
    }
    if (subcommand === '运行') {
      const source = sourceAfterSubcommand(cmdArgs.rawArgs, subcommand);
      if (source === null || source === '') {
        replyDirect(ctx, msg, '用法：.回雪 运行 <回雪代码>');
        return seal.ext.newCmdExecuteResult(true);
      }
      if (source.length > maxRuntimeTomlCharacters) {
        replyDirect(
          ctx,
          msg,
          `回雪：调试代码最多 ${String(maxRuntimeTomlCharacters)} 个字符。`,
        );
        return seal.ext.newCmdExecuteResult(true);
      }
      console.info(
        `[LightScript][runtime-run] sender=${msg.sender.userId} characters=${String(
          source.length,
        )}`,
      );
      runRuntimeCode(
        ctx,
        msg,
        identityFor(ctx, msg),
        source,
        diagnostics,
        runtimeDebugRuntime,
      );
      logNewDiagnostics();
      return seal.ext.newCmdExecuteResult(true);
    }
    if (subcommand === '添加') {
      const source = sourceAfterSubcommand(cmdArgs.rawArgs, subcommand);
      const definition =
        source === null ? null : splitRuntimeReplyDefinition(source);
      if (definition === null) {
        replyDirect(ctx, msg, '用法：.回雪 添加 <精确关键词> | <回复文本>');
        return seal.ext.newCmdExecuteResult(true);
      }
      const result = runtimeReplies.upsert(definition.keyword, definition.text);
      switch (result.kind) {
        case 'added':
          replyDirect(
            ctx,
            msg,
            `回雪：已添加运行时回复“${definition.keyword}”。`,
          );
          break;
        case 'updated':
          replyDirect(
            ctx,
            msg,
            `回雪：已更新运行时回复“${definition.keyword}”。`,
          );
          break;
        case 'invalid':
        case 'missing':
        case 'storage-failed':
          replyDirect(ctx, msg, `回雪：${result.message}`);
          break;
        case 'removed':
          replyDirect(ctx, msg, '回雪：运行时回复状态异常。');
          break;
      }
      logNewDiagnostics();
      return seal.ext.newCmdExecuteResult(true);
    }
    if (subcommand === '添加代码') {
      const source = sourceAfterSubcommand(cmdArgs.rawArgs, subcommand);
      const definition =
        source === null ? null : splitRuntimeReplyDefinition(source);
      if (definition === null) {
        replyDirect(ctx, msg, '用法：.回雪 添加代码 <精确关键词> | <回雪代码>');
        return seal.ext.newCmdExecuteResult(true);
      }
      const result = runtimeReplies.upsertProgram(
        definition.keyword,
        definition.text,
      );
      switch (result.kind) {
        case 'added':
          replyDirect(
            ctx,
            msg,
            `回雪：已添加运行时代码“${definition.keyword}”。`,
          );
          break;
        case 'updated':
          replyDirect(
            ctx,
            msg,
            `回雪：已更新运行时代码“${definition.keyword}”。`,
          );
          break;
        case 'invalid':
        case 'missing':
        case 'storage-failed':
          replyDirect(ctx, msg, `回雪：${result.message}`);
          break;
        case 'removed':
          replyDirect(ctx, msg, '回雪：运行时代码状态异常。');
          break;
      }
      logNewDiagnostics();
      return seal.ext.newCmdExecuteResult(true);
    }
    if (subcommand === '删除') {
      const keyword = sourceAfterSubcommand(
        cmdArgs.rawArgs,
        subcommand,
      )?.trim();
      if (keyword === undefined || keyword === '') {
        replyDirect(ctx, msg, '用法：.回雪 删除 <精确关键词>');
        return seal.ext.newCmdExecuteResult(true);
      }
      const result = runtimeReplies.remove(keyword);
      switch (result.kind) {
        case 'removed':
          replyDirect(ctx, msg, `回雪：已删除“${keyword}”。`);
          break;
        case 'invalid':
        case 'missing':
        case 'storage-failed':
          replyDirect(ctx, msg, `回雪：${result.message}`);
          break;
        case 'added':
        case 'updated':
          replyDirect(ctx, msg, '回雪：运行时回复状态异常。');
          break;
      }
      logNewDiagnostics();
      return seal.ext.newCmdExecuteResult(true);
    }
    if (subcommand === '列表') {
      const replies = runtimeReplies.all();
      if (replies.length === 0) replyDirect(ctx, msg, '回雪：没有运行时回复。');
      else {
        const visible = replies.slice(0, 20);
        const suffix =
          replies.length > visible.length
            ? `\n…另有 ${String(replies.length - visible.length)} 条。`
            : '';
        replyDirect(
          ctx,
          msg,
          `回雪运行时回复（${String(replies.length)}）：\n${visible
            .map((reply, index) => `${String(index + 1)}. ${reply.keyword}`)
            .join('\n')}${suffix}`,
        );
      }
      logNewDiagnostics();
      return seal.ext.newCmdExecuteResult(true);
    }
    return { ...seal.ext.newCmdExecuteResult(true), showHelp: true };
  };
  extension.cmdMap['回雪'] = command;

  extension.getDescText = (): string => diagnostics.summary();
  extension.onNotCommandReceived = (ctx, msg): void => {
    try {
      const identity = identityFor(ctx, msg);
      const runtimeReply = runtimeReplies.find(msg.message);
      if (runtimeReply !== undefined) {
        if (typeof runtimeReply.program === 'string') {
          runRuntimeCode(
            ctx,
            msg,
            identity,
            runtimeReply.program,
            diagnostics,
            runtimeReplyRuntime,
            { document: runtimeReplyDocument, announceEmpty: false },
          );
        } else {
          replyRuntimeText(
            ctx,
            msg,
            identity,
            runtimeReply.text,
            diagnostics,
            runtimeReplyRuntime.variables,
          );
        }
        return;
      }
      const matched = matchDocuments(documents, msg.message);
      for (const item of matched) {
        const runtime = runtimes.get(item.document.id);
        if (runtime === undefined) continue;
        const now = Date.now;
        const address = {
          groupId: identity.groupId,
          senderId: identity.senderId,
        };
        const makeSend = (
          text: string,
          libEnvironment: LibEnvironment,
        ): boolean => {
          const messages = renderOutput(
            text,
            outputContext(identity, msg),
            libEnvironment,
          );
          let sent = false;
          for (const message of messages) {
            try {
              seal.replyToSender(ctx, msg, message);
              sent = true;
            } catch (error) {
              diagnostics.report({
                code: 'reply-failed',
                file: item.document.file,
                message: describeError(error),
                packageId: item.document.id,
                severity: 'error',
              });
            }
          }
          if (sent) runtime.markSent(identity.senderId, now());
          return sent;
        };

        const host: LightScriptHost = {
          context: ctx,
          message: msg,
          now,
          random: Math.random,
          reply: (text: string): boolean => makeSend(text, outputEnvironment),
        };
        const outputEnvironment: LibEnvironment = {
          address,
          auto: item.match.auto,
          document: item.document,
          host,
          reporter: diagnostics,
          variables: runtime.variables,
        };
        const environment: EvaluationEnvironment = {
          ...outputEnvironment,
          captures: item.match.captures,
          lastActivatedAt: runtime.lastActivatedAt(identity.senderId),
        };

        if (item.match.auto.program === undefined) {
          makeSend(outputFromContent(item.match.auto), outputEnvironment);
          continue;
        }
        const result = new LightScriptEvaluator(environment).run();
        makeSend(result.output, outputEnvironment);
      }
    } catch (error) {
      diagnostics.report({
        code: 'message-hook-failed',
        message: describeError(error),
        severity: 'error',
      });
    } finally {
      logNewDiagnostics();
    }
  };
}

main();
