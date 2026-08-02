const extensionName = 'delegated-roll-example';
const existing = seal.ext.find(extensionName);
const extension = existing ?? seal.ext.new(extensionName, '木落', '1.0.0');

const command = seal.ext.newCmdItemInfo();
command.name = 'catch';
command.help = '捕捉某人，格式.catch <@名字>';
command.allowDelegate = true;
command.solve = (ctx, msg, cmdArgs) => {
  const delegated = seal.getCtxProxyFirst(ctx, cmdArgs);
  if (cmdArgs.getArgN(1) === 'help') {
    const result = seal.ext.newCmdExecuteResult(true);
    result.showHelp = true;
    return result;
  }
  const targetName = delegated.player?.name ?? msg.sender.nickname;
  seal.replyToSender(delegated, msg, `正在试图捕捉${targetName}，成功率为${Math.ceil(Math.random() * 100)}%`);
  return seal.ext.newCmdExecuteResult(true);
};

extension.cmdMap.catch = command;
if (existing === null) seal.ext.register(extension);
