const extensionName = 'storage-example';
const existing = seal.ext.find(extensionName);
const extension = existing ?? seal.ext.new(extensionName, '木落', '1.0.0');

const command = seal.ext.newCmdItemInfo();
command.name = '投喂';
command.help = '投喂，格式: .投喂 <物品>\n.投喂 记录 // 查看记录';
command.solve = (ctx, msg, cmdArgs) => {
  const item = cmdArgs.getArgN(1);
  if (item === 'help' || item === '') {
    const result = seal.ext.newCmdExecuteResult(true);
    result.showHelp = true;
    return result;
  }
  const data = JSON.parse(extension.storageGet('feedInfo') || '{}');
  if (item === '列表' || item === '记录' || item === 'list') {
    const rows = Object.entries(data).map(([name, count]) => `- ${name}: 数量 ${count}`);
    seal.replyToSender(ctx, msg, `投喂记录:\n${rows.join('\n')}`);
    return seal.ext.newCmdExecuteResult(true);
  }
  const name = item || '空气';
  data[name] = (data[name] ?? 0) + 1;
  extension.storageSet('feedInfo', JSON.stringify(data));
  seal.replyToSender(ctx, msg, `你给海豹投喂了${name}，要爱护动物！`);
  return seal.ext.newCmdExecuteResult(true);
};

extension.cmdMap.投喂 = command;
extension.cmdMap.feed = command;
if (existing === null) seal.ext.register(extension);
