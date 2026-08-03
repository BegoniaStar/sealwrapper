# 网络请求

来自 `examples_ts/011.网络请求.ts`。`.musicsearch [关键词]` 通过 SealDice 的 fetch 入口请求授权 host。test-only bridge 不访问真实外网，只允许 manifest 中声明的 host，并要求 scenario 提供精确匹配的 HTTP mock route；未声明 host 或未匹配 route 会 fail-closed。
