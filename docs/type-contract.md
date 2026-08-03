# SealDice 类型契约维护

本页主要面向 sealwrapper 维护者。普通插件作者只需运行 `types sync`、`types verify` 和
`typecheck`，不应修改本仓库的 `api/`、`types/` 或目标注册表。

## 契约为何是“扫描 + 审核”

每个已注册 SealDice 目标都有一份经过审核的 TypeScript 契约。当前为 `1.6.0`：

```text
tools/seal-api-scan/                 Go AST scanner
api/sealdice/1.6.0/inventory.json    已提交的生产 API inventory
api/sealdice/1.6.0/seal.d.ts.template 审核过的 TypeScript 语义层
api/sealdice/1.6.0/semantic-override.json 允许的显式差异
api/sealdice/1.6.0/report.md         可读 inventory 报告
types/sealdice/1.6.0/seal.d.ts       生成的公开声明
```

只从 Go 函数签名生成 `.d.ts` 并不准确：Goja 转换、可选参数、回调、空值和动态对象都需要
人工判断。因此 scanner 提供客观的 AST inventory，模板提供审核后的 JavaScript 语义，二者
必须在覆盖规则下相互验证。

## Scanner 做什么

`tools/seal-api-scan/` 用 `go/parser` 只解析受管核心的生产 `dice/**/*.go` 文件；它不导入也
不构建核心。scanner 提取：

- `Dice.JsInit` 中建立的 `seal.*` 对象和嵌套 `Set(...)` 成员；
- 函数种类、接收的最小参数数、Go 签名与源码位置；
- 具备 `jsbind` 标签的返回对象字段；
- 仅由非测试 Go 文件计算的 source fingerprint。

测试文件不参与 fingerprint，因此测试专用 bridge overlay 无法伪造生产 API。`types audit`
还会扫描真实 reply parser 的 `condType`、`matchType`、`matchOp`、`resultType` 词汇，并与
overlay 中严格检查器比较。

## 普通插件作者流程

```sh
sealw types sync --target 1.6.0
sealw types verify --target 1.6.0
sealw typecheck --target 1.6.0
```

- 未给 `--target` 时使用项目的 `defaultTarget`。
- `types sync` 在项目 `.seal/types/` 生成声明，并带有目标、运行时、提交与内容摘要头。
- `types verify` 发现声明缺失、过期或被编辑时失败；直接重新同步，不要手改。
- `typecheck` 使用这份声明检查 `src/`，不输出 JS。`package` 会对每个待发布目标再次运行它。

## 审计已锁定核心

维护者在目标来源或核心提交发生预期变化后，先同步并审计：

```sh
sealw core sync --target 1.6.0
sealw types audit --target 1.6.0
```

`audit` 是只读的。它比较实际 AST inventory 与已提交 inventory，并验证生产 reply grammar
与签名 overlay 的严格检查器完全一致。任何新增、删除、签名变化或 grammar 差异都必须先
人工评审；不要让 CI 自动吸收这种变化。

## 受控更新

审查通过后，维护者可显式重写 sealwrapper 所有的契约输出：

```sh
sealw types update --write --target 1.6.0
```

`--write` 是防止误操作的确认。该命令仅重写该目标的 inventory、生成的 `.d.ts` 和报告；它
仍要求已经通过 `core verify` 的受管核心，且不会接收用户指定的核心路径。

提交前至少审阅：

1. `inventory.json` 的新增、删除和函数签名变化是否对应预期的生产核心改动；
2. `seal.d.ts.template` 是否为新成员提供可用且保守的 JavaScript 语义；
3. `semantic-override.json` 中每个 inventory-only 或 declaration-only 路径是否有明确理由；
4. `report.md` 和 `types/.../seal.d.ts` 是否是可复现的派生输出；
5. reply grammar 变化是否同时有审查过的新测试 overlay 和信任描述符。

## 何时加入新目标

新增目标不是只增加一个 `.d.ts` 目录。新的 sealwrapper 发布必须以一个完整单元加入：

- `src/pinned-target.ts` 中的不可变 target descriptor；
- `api/sealdice/<target>/` 的 inventory、模板、override 和报告；
- `types/sealdice/<target>/seal.d.ts`；
- `patches/sealdice-core/<target>/` 的测试专用 overlay；
- 核心来源、镜像、提交、运行时版本、bridge capabilities 和 Ed25519 信任签名。

然后针对多目标项目运行 `lock update` 和 `package`。目标列表是用户兼容性声明的唯一来源，
不能通过旧的 `compatibilityTargets` 等字段旁路。

## 验证

```sh
mise exec -- npm run test:api-scanner
mise exec -- npm test
mise exec -- npm run test:integration:required
```

完整仓库门禁为 `mise exec -- npm run check`。它同时覆盖 AST scanner、契约渲染、受管核心
审计、bridge integration 和所有示例。
