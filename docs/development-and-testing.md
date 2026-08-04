# 开发与测试

本页说明日常开发命令的执行顺序和输出。默认在包含 `seal.config.json`、`seal.lock` 的项目
根目录运行。

## 受管状态的边界

所有自动生成或下载内容都在 `.seal/`：

```text
.seal/core/<target>/mirror.git    锁定来源的裸 Git 镜像
.seal/core/<target>/worktree      固定提交的分离 worktree 和测试专用 overlay
.seal/core/<target>/state.json    受管状态记录
.seal/types/sealdice-<target>.d.ts 生成的目标 TypeScript 声明
.seal/stage/                      资源检查前生成的临时 archive
.seal/reports/                    场景报告及冻结的媒体
```

这些路径由工具拥有。不要手改、替换符号链接或让其他脚本向其中写入核心文件；每次
`core verify` 都会检查路径、镜像来源、提交、补丁哈希、能力和信任签名。

## 1. 检查工具链

```sh
sealw doctor
```

该命令读取项目锁文件，报告 Node、Git 和每个所选目标要求的 Go 版本。它先于同步执行，
因此不会创建镜像或 worktree。正常项目应通过 mise 执行：

```sh
mise exec -- sealw doctor
```

若 Go 不匹配，先在工具仓库执行 `mise install`，再从由 mise 管理的环境运行命令。不要用
`--allow-dirty` 或手改 state 来规避工具链错误。

## 2. 同步和验证核心

```sh
sealw core sync
sealw core verify
```

`core sync` 会针对默认目标创建受管镜像和 worktree；显式选择目标：

```sh
sealw core sync --target 1.6.0
```

首次同步从 lock 指定、签名允许的 HTTPS mirror 集合取得 Git 对象，随后将 `origin` 固定
为规范来源、检出锁定提交、应用仅修改 `*_test.go` 的 bridge overlay，并运行目标锁定的 Go
测试。它不会接受 `--core` 或用户自行准备的核心目录。

已缓存并验证过核心时可使用：

```sh
sealw core sync --offline
```

离线模式绝不 clone 或 fetch；缓存不存在或不完整时失败。`core verify` 不联网也不修改
核心，它验证镜像、worktree、提交、overlay、能力和状态是否完整可信。

## 3. 类型契约和 TypeScript

```sh
sealw types sync
sealw types verify
sealw typecheck
```

`types sync` 从 sealwrapper 内置、审查过的目标契约生成
`.seal/types/sealdice-<target>.d.ts`；`types verify` 检查该受管输出没有缺失、陈旧或被编辑。
`typecheck` 会先同步声明，再按项目 `tsconfig.json` 检查 `src/`，不产生 JavaScript。

没有 `tsconfig.json` 时，工具会检查 `src/` 下的 JS/TS 文件，并启用 `checkJs`；有
JavaScript bundle 的项目可借此发现不存在的 SealDice API。只含资源的项目没有 `build`，不能
运行 `typecheck`。

插件作者通常只用上面三条。`types audit` 和 `types update --write` 面向 sealwrapper
维护者，详见[类型契约维护](type-contract.md)。

## 4. 资源检查和 SARIF

```sh
sealw resource check
sealw resource check --sarif .seal/reports/resources.sarif
```

此命令会：

1. 验证 `seal.config.json` 与 `seal.lock`。
2. 生成 deterministic staging archive：`README.md`、生成的脚本、声明的内容根和资产。
3. 用受管 bridge 调用目标核心的严格资源验证。
4. 输出每条诊断；成功时报告归档名称和目标 ID。

未给 `--target` 时，资源检查会覆盖 `buildTarget` 中的每个目标。若同时给 `--sarif`，多目标
输出会自动把目标 ID 加入文件名，防止报告相互覆盖。SARIF 路径必须是项目相对路径。

## 5. 宿主冒烟测试

```sh
sealw test
```

`test` 在每个选中目标上先执行资源检查，随后运行真实的 Install -> Enable -> Reload。它检查
包可被实际核心安装、启用并重新加载，不能替代场景测试，也不能被单纯的 bundle 成功替代。

## 6. 场景测试与报告

```sh
sealw scenario test
sealw scenario test --release
sealw scenario test --snapshot
sealw scenario test --update-snapshots
sealw scenario test --render --png --theme dark --style compact --members
```

场景目录必须是 `tests/scenarios/`，文件必须是 `.json`。每个文件在一个连续 fake-QQ 会话中
执行；同一场景的后一条消息可以读取前一条消息造成的扩展状态。

- `--release` 只运行 `"release": true` 的场景。
- `--snapshot` 比较已存在的 JSON transcript 快照；`--update-snapshots` 写入或覆盖快照，
  两者不能并用。
- `--render` 在 `.seal/reports/` 写入冻结的 JSON、SVG、HTML 和 identity 元数据。
- `--png` 需要 `--render`，并要求本机安装 `rsvg-convert` 或 ImageMagick 的 `magick`。
- `--offline` 只使用本地 identity cache；`--refresh-identities` 在线刷新 QQ 公共身份缓存。

断言的权威来源始终是 bridge 输出的 JSON transcript。SVG、HTML 和 PNG 是诊断产物，不会
改变快照、包校验和或发布门禁。完整字段说明见[场景与报告](scenario-testing.md)。

## 7. 本地 watch

```sh
sealw watch
sealw watch --once
```

`watch` 只适用于有 `build` 的项目。它监视 `src/` 并重建 `.seal/stage/` 下的本地 archive；
不会连接、上传或重载真实 SealDice 宿主。资源项目应使用 `resource check`，不能把 watch 当成
资源验证器。

## 8. 机器可读输出

除 `package` 外的命令支持统一输出格式：

```sh
sealw resource check --format json
sealw scenario test --format junit
```

`text` 是默认格式。`json` 生成一个 `sealwrapper.cli/v1` envelope，`junit` 生成一个
JUnit testsuite。场景命令会在两种机器格式中分别记录每个 `目标 × 场景` 的名称、耗时和失败，
便于 CI 直接定位。动画进度仅在交互式 TTY 使用 stderr；CI、管道、注入 writer 或机器输出时
会自动静默，不会污染 stdout。

## 建议的提交前顺序

```sh
sealw core verify
sealw types verify
sealw typecheck
sealw resource check
sealw test
sealw scenario test --release --snapshot
```

准备发布时改用 `sealw package`。它会重复必要的门禁，不能因先前手动运行成功而跳过。
