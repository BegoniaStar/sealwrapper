const extensionName = 'custom-command-example';
const existing = seal.ext.find(extensionName);
const extension = existing ?? seal.ext.new(extensionName, '木落', '1.0.0');

const cmdSeal = seal.ext.newCmdItemInfo();
cmdSeal.name = 'seal';
cmdSeal.help = '召唤一只海豹，可用.seal <名字> 命名';
cmdSeal.solve = (ctx, msg, cmdArgs) => {
  let name = cmdArgs.getArgN(1);
  if (name === 'help') {
    const result = seal.ext.newCmdExecuteResult(true);
    result.showHelp = true;
    return result;
  }
  if (!name) name = '氪豹';
  seal.replyToSender(ctx, msg, `你抓到一只海豹！取名为${name}\n它的逃跑意愿为${Math.ceil(Math.random() * 100)}`);
  return seal.ext.newCmdExecuteResult(true);
};

extension.cmdMap.seal = cmdSeal;
if (existing === null) seal.ext.register(extension);
