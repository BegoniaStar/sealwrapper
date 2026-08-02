const rule = seal.coc.newRule();
rule.index = 20;
rule.key = '测试';
rule.name = '自设规则';
rule.desc = '出1大成功\n出100大失败';

rule.check = (_ctx, d100, checkValue) => {
  const criticalSuccessValue = 1;
  const fumbleValue = 100;
  let successRank = d100 <= checkValue ? 1 : -1;
  if (successRank === 1) {
    if (d100 <= checkValue / 2) successRank = 2;
    if (d100 <= checkValue / 5) successRank = 3;
    if (d100 <= criticalSuccessValue) successRank = 4;
  } else if (d100 >= fumbleValue) {
    successRank = -2;
  }
  const result = seal.coc.newRuleCheckResult();
  result.successRank = successRank;
  result.criticalSuccessValue = criticalSuccessValue;
  return result;
};

seal.coc.registerRule(rule);
