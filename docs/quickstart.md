# 从零开始

本教程创建一个混合型 SealDice 包：它既有 TypeScript 指令，也预留资源内容目录。最后会
得到一份经过类型检查、资源校验、宿主安装测试和场景测试的 `.sealpack`。

## 1. 准备工具

先在 sealwrapper 工具仓库中安装固定工具链并构建 CLI：

```sh
mise install
mise exec -- npm ci
mise exec -- npm install -g .
sealw --help
```

`mise install` 会安装 Node `26.5.0` 和 Go `1.25.0`。不要跳过它：`core sync`、
`doctor` 和真实 bridge 都会拒绝未锁定的 Go 版本。

本教程为清晰起见使用全局 `sealw`。初始化模板会生成一个 `./sealw` 启动脚本，但不会替你
创建 `package.json` 或安装 npm 依赖。希望使用该项目本地脚本时，先把同一版本的
`sealwrapper` 添加为项目的开发依赖并提交 `package-lock.json`，然后运行 `./sealw`；否则
继续使用全局 CLI 即可。

## 2. 初始化项目

```sh
sealw init hello-seal --kind hybrid --no-sync
cd hello-seal
```

`--kind` 的可选值如下：

| 类型 | 适用情况 | 初始内容 |
| --- | --- | --- |
| `js` | 只有脚本扩展 | `src/`、`tests/unit/`、脚本 bundle 配置 |
| `resource` | 只有牌堆或自动回复等资源 | `content/decks/`、`content/reply/` |
| `hybrid` | 脚本和资源共存 | 上述两者 |

不使用 `--no-sync` 时，初始化会立即同步核心；第一次同步需要网络。`--no-sync` 适合
先检查生成的文件或在稍后统一准备环境。

项目根目录中最重要的文件是：

```text
seal.config.json       包元数据、内容、权限和目标选择
seal.lock              签名的目标描述符，版本为 lock v3
src/index.ts           JavaScript/TypeScript 扩展入口（js/hybrid）
tests/unit/            JavaScript 发布门禁需要的项目单元测试（js/hybrid）
tests/scenarios/       作者添加的 fake-QQ 场景
content/               资源内容（resource/hybrid）
README.md              会被放入最终 sealpack
.seal/                 受管核心、类型、staging、报告；不提交
```

## 3. 检查并同步宿主核心

```sh
sealw doctor
sealw core sync
sealw types sync
sealw types verify
```

`doctor` 在写入任何受管状态前检查 Node、Git 和选中目标要求的 Go。`core sync` 创建
`.seal/core/1.6.0/` 下的锁定镜像、分离 worktree 和测试专用 overlay；它不会使用或修改
你已有的 SealDice checkout。`types sync` 将受审核的 `seal.*` 声明写入
`.seal/types/`，该文件是受管文件，不要手改。

## 4. 注册第一条命令

用下面内容替换 `src/index.ts`：

```ts
const extensionName = 'hello-seal';
const existing = seal.ext.find(extensionName);
const extension = existing ?? seal.ext.new(extensionName, 'Your Name', '0.1.0');

const command = seal.ext.newCmdItemInfo();
command.name = 'hello';
command.help = '发送问候；用法：.hello [名字]';
command.solve = (ctx, msg, args) => {
  const name = args.getArgN(1) || '朋友';
  seal.replyToSender(ctx, msg, `你好，${name}！`);
  return seal.ext.newCmdExecuteResult(true);
};

extension.cmdMap.hello = command;
if (existing === null) seal.ext.register(extension);
```

同时更新 `seal.config.json` 中的 `package`、`sealpack.packageId` 和 `homepage`。包 ID
必须是 `作者/包名`，版本必须是规范 SemVer。脚本元数据头由打包器从这些字段生成，不要在
源码中手写 UserScript metadata。

## 5. 添加场景

创建 `tests/scenarios/hello.json`：

```json
{
  "release": true,
  "title": "hello 指令回复传入名字",
  "clock": "2026-08-01T00:00:00Z",
  "messages": [
    { "sequence": 1, "qq": "3909311212", "nickname": "Alice", "text": ".hello Alice" }
  ],
  "expect": {
    "outputs": [
      { "inReplyToSequence": 1, "text": "你好，Alice！" }
    ]
  }
}
```

场景中的输出按发生顺序断言。`inReplyToSequence` 指向作者写入的输入序号，而不是输出
在 transcript 中的序号。把 `release` 标为 `true`，可让 CI 使用
`sealw scenario test --release` 只执行发布场景。

## 6. 本地验证

```sh
sealw typecheck
sealw resource check
sealw test
sealw scenario test --release
```

各命令的职责不同：

- `typecheck`：检查 `src/` 是否只调用当前目标公开的 `seal.*` API。
- `resource check`：先构建 staging archive，再由受管核心严格验证资源和 manifest。
- `test`：在资源检查后执行 Install -> Enable -> Reload。
- `scenario test`：每个场景都运行在连续、确定性 fake-QQ 会话中。

脚本项目还必须保留至少一个 `tests/unit/*.test.ts` 或 JavaScript 测试；`package` 的
JavaScript 质量门禁会运行它们。进一步解释见[开发与测试](development-and-testing.md)。

## 7. 发布

```sh
sealw package
```

发布只会在所有选中目标通过类型检查、资源检查、Install -> Enable -> Reload、项目单元
测试和制品策略后开始。输出位于 `release/`，包含：

```text
<package>@<version>.sealpack
<package>@<version>.sealpack.sha256
<package>@<version>.sealpack.release.json
```

发布不会覆盖已有同名文件。关于签名、可复现时间戳和 CI，请继续阅读
[发布与 CI](release-and-ci.md)。
