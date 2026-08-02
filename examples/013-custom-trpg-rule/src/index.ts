const ruleText = `《摸鱼大赛》

每个角色有脸皮厚度、摸鱼技能等级和生命值；生命值上限 = 脸皮厚度 * 2。
每轮选择“摸鱼”或“不摸鱼”。摸鱼获得 d6 + d(摸鱼等级) 积分，目标是接近 21；达到 22 时失去生命值并随机弃牌，生命值归零后不能继续摸鱼。`;

const template = {
  name: 'fish',
  fullName: '示例:TRPG规则-摸鱼大赛！',
  authors: ['木落'],
  version: '1.0.0',
  updatedTime: '20230326',
  templateVer: '1.0',
  setConfig: { diceSides: 6, enableTip: '已切换至6面骰，并自动开启摸大鱼(fish)扩展', keys: ['fish', '摸鱼'], relatedExt: ['fish', 'coc7'] },
  nameTemplate: { fish: { template: '{$t玩家_RAW} HP{生命值}/{生命值上限} 摸鱼{摸鱼} 点数{点数}', helpText: '自动设置测试名片' } },
  attrConfig: { top: ['脸皮', '摸鱼', '生命值', '点数'], sortBy: 'name', ignores: ['生命值上限'], showAs: { 生命值: '{生命值}/{生命值上限}' }, setter: null },
  defaults: { 上工: 5 },
  defaultsComputed: { 生命值上限: '脸皮 * 2' },
  alias: { 生命值: ['hp'], 生命值上限: ['hpmax'], 摸鱼: ['fish'], 脸皮: ['face'] },
  textMap: { 'fish-test': { 设置测试_成功: [['设置完成', 1]] } },
  textMapHelpInfo: null,
};

try {
  seal.gameSystem.newTemplate(JSON.stringify(template));
} catch (error) {
  console.log(error);
}

const existing = seal.ext.find('fish');
const extension = existing ?? seal.ext.new('fish', '木落', '1.0.0');
const historyByPlayer: Record<string, number[]> = {};

const command = seal.ext.newCmdItemInfo();
command.name = 'fish';
command.help = '.fish 规则 //规则讲解\n.fish 制卡 // 创建角色\n.fish 1 // 进行一次摸鱼\n.fish 2 // 跳过本轮\n.fish clr // 清除摸鱼数据';
command.solve = (ctx, msg, cmdArgs) => {
  const action = cmdArgs.getArgN(1);
  const playerId = ctx.player?.userId ?? msg.sender.userId;
  if (action === 'help') {
    const result = seal.ext.newCmdExecuteResult(true);
    result.showHelp = true;
    return result;
  }
  if (action === '规则') {
    seal.replyToSender(ctx, msg, ruleText);
  } else if (action === '制卡') {
    seal.replyToSender(ctx, msg, seal.format(ctx, '.st 脸皮:{$t1=1d3} 摸鱼:{1d3} 生命值:{$t1 * 2}'));
  } else if (action === '2') {
    seal.replyToSender(ctx, msg, seal.format(ctx, '{$t玩家}跳过此轮'));
  } else if (action === 'clr') {
    historyByPlayer[playerId] = [];
    seal.replyToSender(ctx, msg, '数据已清除');
  } else if (action === '1') {
    const die = Number.parseInt(seal.format(ctx, '{d6}'), 10);
    const skill = Number.parseInt(seal.format(ctx, '{d(摸鱼)}'), 10);
    const history = historyByPlayer[playerId] ?? [];
    history.push(die + skill);
    historyByPlayer[playerId] = history;
    let total = history.reduce((sum, value) => sum + value, 0);
    let [hp] = seal.vars.intGet(ctx, '生命值');
    let output = seal.format(ctx, `{$t玩家}选择了摸鱼！点数为${die} + ${skill}\n当前点数: ${history.join(',')} = ${total}`);
    while (total >= 22 && history.length > 0) {
      const index = Math.floor(Math.random() * history.length);
      const discarded = history.splice(index, 1)[0];
      total -= discarded;
      hp -= 1;
      output += `\n随机弃牌: ${discarded}`;
    }
    seal.vars.intSet(ctx, '生命值', hp);
    seal.vars.intSet(ctx, '点数', total);
    if (hp <= 0) output += seal.format(ctx, '\n{$t玩家}挂了！');
    seal.replyToSender(ctx, msg, `${output}${seal.format(ctx, '\n生命值: {生命值} 点数: {点数}')}`);
  } else {
    const result = seal.ext.newCmdExecuteResult(true);
    result.showHelp = true;
    return result;
  }
  return seal.ext.newCmdExecuteResult(true);
};

extension.cmdMap.fish = command;
extension.cmdMap.摸鱼 = command;
if (existing === null) seal.ext.register(extension);
