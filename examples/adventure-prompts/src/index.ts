const extensionName = 'adventure-prompts';
const deckName = '冒险灵感';

const existing = seal.ext.find(extensionName);
const extension = existing ?? seal.ext.new(extensionName, 'Sealwrapper 示例', '1.0.0');

const inspire = seal.ext.newCmdItemInfo();
inspire.name = 'inspire';
inspire.help = '.inspire // 从“冒险灵感”JSON 牌堆抽取一条城市冒险起点';
inspire.solve = (ctx, msg) => {
  const draw = seal.deck.draw(ctx, deckName, false);
  const text = draw.exists
    ? `JS灵感：${draw.result}`
    : `找不到 JSON 牌堆中的“${deckName}”牌组。`;
  seal.replyToSender(ctx, msg, text);
  return seal.ext.newCmdExecuteResult(true);
};

extension.cmdMap.inspire = inspire;
if (existing === null) seal.ext.register(extension);
