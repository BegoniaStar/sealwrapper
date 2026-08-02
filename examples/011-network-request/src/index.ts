const extensionName = 'network-request-example';
const existing = seal.ext.find(extensionName);
const extension = existing ?? seal.ext.new(extensionName, '木落', '1.0.0');

const command = seal.ext.newCmdItemInfo();
command.name = 'musicsearch';
command.help = '查询音乐，格式 .musicsearch [关键词]';
command.solve = (ctx, msg, cmdArgs) => {
  const keywords = cmdArgs.getArgN(1) || '稻香';
  const endpoint = `https://api-music.imsyy.top/cloudsearch?keywords=${encodeURIComponent(keywords)}`;
  seal.replyToSender(ctx, msg, `网络请求示例（未发送）：${endpoint}`);
  return seal.ext.newCmdExecuteResult(true);
};

extension.cmdMap.musicsearch = command;
if (existing === null) seal.ext.register(extension);
