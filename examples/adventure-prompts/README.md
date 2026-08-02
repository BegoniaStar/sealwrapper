# 城市冒险灵感

这是一个完整的 schema-v1 混合 `.sealpack` 示例：

- `content/decks/adventure-prompts.json` 是一个 JSON 牌堆，导出 `冒险灵感` 牌组；
- `content/reply/adventure.yaml` 使用 `#{DRAW-冒险灵感}`，由真实 core 的牌堆 matcher 抽取内容；
- `src/index.ts` 注册 `.inspire`，通过 `seal.deck.draw(ctx, '冒险灵感', false)` 抽取同一牌组。

因此“来点灵感”走自动回复，而 “`.inspire`” 走 JS 指令；两者都从同一个 JSON 牌堆取得结果。

## 运行

在本仓库根目录已安装依赖、并已通过 mise 提供 Go 1.25.0 后：

```sh
cd examples/adventure-prompts
../../sealw core sync --target 1.6.0
../../sealw resource check --target 1.6.0
../../sealw scenario test --target 1.6.0 --release
../../sealw package --target 1.6.0
```

牌堆场景固定 clock 和 seed，并使用 `random.oneOf` 限定 JSON 牌堆的合法结果；其中 `repeatable: true` 会再运行一次 bridge，确认同一 seed 的 transcript 一致。另一个场景用真实 core 的 `#{SPLIT}` 路径验证一条自动回复会拆成两条连续 QQ 消息。`package` 会额外执行 JS 单元测试、严格资源校验与真实的 Install → Enable → Reload smoke。

若希望查看离线报告，可在成功的场景测试后追加 `--render --offline`；报告只写入 `.seal/reports/`，从不进入 release 制品。
