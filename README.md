# sealwrapper

`sealwrapper`（命令名 `sealw`）是为 [SealDice](https://github.com/sealdice/sealdice-core)
`sealpack` 插件准备的开发与发布工具。它负责构建可复现的 `.sealpack`、使用受管
SealDice 核心校验包内容，并提供 TypeScript 类型契约、确定性 fake-QQ 场景、离线报告
和发布溯源信息。

当前目标注册表只支持 SealDice `1.6.0`。项目始终是 sealpack-only：工具不会发布裸
JavaScript 扩展、不会接收用户指定的核心目录，也不会分发 SealDice 核心、桥接器或
验证器二进制文件。

[English README](README.en.md) | [文档目录](docs/README.md)

## 能做什么

- 初始化 JavaScript、纯资源或混合型 SealDice 插件项目。
- 在 `seal.lock` v3 中锁定每个目标的核心提交、测试专用 bridge overlay、API 契约和
  信任描述符。
- 打包可选 JavaScript bundle，以及 `decks`、`reply`、`helpdoc`、`templates` 和
  `assets` 五类受支持内容。
- 以目标专属的 `seal.*` 声明检查插件 TypeScript 代码。
- 用受管核心完成严格资源检查和真实的 Install -> Enable -> Reload 冒烟测试。
- 运行确定性的 fake-QQ 场景、快照、封闭 HTTP mock，以及离线 JSON/SVG/HTML/PNG
  聊天记录报告。
- 生成确定性归档、SHA-256 校验和、发布溯源文件，并可选用 Ed25519 签名溯源文件。

## 支持的平台

唯一受支持的执行环境是具有 POSIX shell 的 Linux，也是 CI 唯一覆盖的平台。macOS 在本地工具链
自行满足要求时可能可以工作，但不属于受支持或测试的平台。Windows 不受支持：安装后的 `sealw`
启动器有意使用 POSIX shell 脚本。

## 环境要求

仓库的 [`.mise.toml`](.mise.toml) 固定了开发工具链：

| 工具 | 要求版本 | 用途 |
| --- | --- | --- |
| Node.js | `>=26.5.0 <27` | CLI、打包、TypeScript 和测试 |
| Go | `1.25.0` | 受管核心 bridge 与 API scanner |
| Git | `PATH` 中可用 | 锁定核心的镜像与 worktree |

请优先使用 [mise](https://mise.jdx.dev/)。即使系统安装了更高版本的 Go，也不会通过
检查：bridge 必须使用所选目标锁定的精确 Go 版本。

## 安装

当前版本通过私有 Git 仓库提供。在工具仓库目录中执行：

```sh
git clone https://github.com/BegoniaStar/sealwrapper.git
cd sealwrapper
mise install
mise exec -- npm ci
mise exec -- ./sealw --help
```

需要在其他目录直接使用 `sealw` 时，可安装编译后的全局 CLI：

```sh
mise exec -- npm install -g .
sealw --help
```

第一次运行 `core sync` 需要联网、Git 和 Go `1.25.0`，以获取锁定的核心。`--offline`
不会下载任何内容，只有本地已经存在通过验证的受管核心时才能成功。

## 五分钟开始

下面的命令创建一个混合型插件；`--no-sync` 让初始化步骤本身不下载核心。示例假设你
已经按上节安装了全局 `sealw`：

```sh
sealw init my-first-plugin --kind hybrid --no-sync
cd my-first-plugin
sealw doctor
sealw core sync
sealw types sync
sealw typecheck
sealw resource check
sealw test
sealw package
```

`init` 会生成 `seal.config.json`、`seal.lock`、`README.md`、忽略 `.seal/` 的规则、
源码入口以及最小单元测试。随后在 `src/index.ts` 注册指令，在 `tests/scenarios/` 写入
场景 JSON，再发布。完整过程请看[从零开始](docs/quickstart.md)。

## 常用工作流

| 目的 | 命令 |
| --- | --- |
| 检查本机工具链 | `sealw doctor` |
| 同步或验证受管核心 | `sealw core sync` / `sealw core verify` |
| 同步或验证目标声明 | `sealw types sync` / `sealw types verify` |
| 检查插件源码 | `sealw typecheck` |
| 构建并校验资源 | `sealw resource check` |
| 在受管宿主中测试安装 | `sealw test` |
| 运行 fake-QQ 场景 | `sealw scenario test` |
| 修改源码时重建本地 staging | `sealw watch` |
| 通过全部门禁后发布 | `sealw package` |

未传 `--target` 时，包校验命令会运行 `sealDice.buildTarget` 中的每个目标；需要单个
声明或核心的命令则使用 `sealDice.defaultTarget`。可随时用 `sealw <命令> --help` 查看
当前版本可接受的参数。文档采用 `core sync`、`scenario test` 这类双词形式。

## 使用文档

- [从零创建第一个插件](docs/quickstart.md)
- [配置包、内容与目标矩阵](docs/configuration.md)
- [开发、类型检查、资源检查和测试](docs/development-and-testing.md)
- [编写场景并导出报告](docs/scenario-testing.md)
- [发布、签名与 CI](docs/release-and-ci.md)
- [维护目标 API 契约](docs/type-contract.md)
- [实现模块与测试映射](docs/implementation-map.md)

## 示例

[`examples/`](examples/) 中的每个目录都是可以独立运行的包。建议先看小型的
[`004-custom-command`](examples/004-custom-command/)，然后阅读混合型示例
[`adventure-prompts`](examples/adventure-prompts/)。其余示例覆盖存储、上下文数据、
代骰、HTTP mock、自定义规则，以及迁移后的
[`lightscript-loader`](examples/lightscript-loader/)。

执行全部示例回归：

```sh
mise exec -- npm run test:examples
```

`mise exec -- npm run test:examples -- --plan` 只显示计划，不同步核心；
`test:examples:offline` 则要求每个示例都已有通过验证的本地核心缓存。

## 验证本仓库

```sh
mise install
mise exec -- npm ci
mise exec -- npm run check
```

`check` 会构建 CLI、检查源码格式与危险 TypeScript/JavaScript 结构、审计 npm 漏洞和 registry
签名、对单元测试和受管核心集成测试统一执行覆盖率门槛、运行 Go API scanner、对实际打包并安装后
的 npm CLI 做冒烟测试，并执行全部示例。CI 还会安装 Noto CJK 字体和 `rsvg-convert`，以生成可复现
的离线 PNG 报告。仓库管理员设置见[安全与维护](docs/security-and-maintenance.md)。

## 许可证

[MIT](LICENSE)
