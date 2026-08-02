const extensionName = 'deck-template-example';
const deckName = '调查员';
const existing = seal.ext.find(extensionName);
const extension = existing ?? seal.ext.new(extensionName, '木落', '1.0.0');

const command = seal.ext.newCmdItemInfo();
command.name = 'drawpc';
command.help = '抽取一个调查员';
command.solve = (ctx, msg) => {
  const draw = seal.deck.draw(ctx, deckName, true);
  if (draw.err) {
    seal.replyToSender(ctx, msg, draw.exists ? draw.err : '牌堆不存在。');
    return seal.ext.newCmdExecuteResult(true);
  }
  seal.vars.strSet(ctx, '$t牌组', deckName);
  const templatePrefix = seal.formatTmpl(ctx, '其他:抽牌_结果前缀');
  const prefix = templatePrefix.startsWith('<%未知项-') ? '调查员：' : templatePrefix;
  seal.replyToSender(ctx, msg, `${prefix}${draw.result}`);
  return seal.ext.newCmdExecuteResult(true);
};

extension.cmdMap.drawpc = command;
if (existing === null) seal.ext.register(extension);
