const extensionName = 'context-data-example';
const existing = seal.ext.find(extensionName);
const extension = existing ?? seal.ext.new(extensionName, '木落', '1.0.0');

const command = seal.ext.newCmdItemInfo();
command.name = 'info';
command.help = '查看当前群、玩家和角色卡数据';
command.solve = (ctx, msg, cmdArgs) => {
  if (cmdArgs.getArgN(1) === 'summary') {
    seal.replyToSender(ctx, msg, '已读取群数据、玩家数据和当前角色卡数据。');
    return seal.ext.newCmdExecuteResult(true);
  }
  const rows = (object: object | null) => Object.entries(object ?? {})
    .filter(([, value]) => typeof value !== 'function')
    .map(([key, value]) => `${key}:${value}\n`)
    .join('');
  const displayAttributes = ['力量', '敏捷', '新属性'];
  const attributeRows = () => displayAttributes.map((key) => {
    const [value, exists] = seal.vars.intGet(ctx, key);
    return exists ? `${key}:${value}\n` : '';
  }).join('');
  let output = `群数据\n${rows(ctx.group)}玩家数据\n${rows(ctx.player)}当前角色卡数据\n${attributeRows()}`;
  output += '----\n修改后角色卡数据\n';
  seal.vars.intSet(ctx, '新属性', 10);
  output += attributeRows();
  seal.replyToSender(ctx, msg, output);
  return seal.ext.newCmdExecuteResult(true);
};

extension.cmdMap.info = command;
if (existing === null) seal.ext.register(extension);
