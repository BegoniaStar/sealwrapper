# 发布与 CI

`sealw package` 是唯一的发布入口。它并非简单压缩文件，而是执行与所选目标绑定的完整门禁，
并只在所有步骤成功后将完整发布集写入项目的 `release/` 目录。

## 发布前准备

在项目根目录确认以下内容：

```sh
sealw core verify
sealw types verify
sealw typecheck
sealw resource check
sealw test
sealw scenario test --release --snapshot
```

这些命令有助于快速定位失败点，但不替代 `package`。发布命令会再次执行所需门禁。只含资源的
项目没有 `build`，因此无需 `typecheck`；含 JavaScript 的项目必须有 `src/` 和至少一个
`tests/unit/*.test.{ts,js}` 文件。

`core sync` 还会下载并校验目标描述符所钉定的上游 Linux amd64 release artifact SHA-256，
`core verify` 会再次校验缓存字节。桥接门禁本身在同一提交的受管源码和 test-only overlay
上运行，因此它证明的是锁定的 source-core compatibility，而不是把未执行的二进制误称为
运行时 smoke。

## 发布命令

```sh
sealw package
```

发布始终覆盖 `sealDice.buildTarget` 的完整目标矩阵；`package` 不接受 `--target`，避免声明了多
版本兼容却只验证一个目标。排查单个目标时，请使用不发布的验证命令：

```sh
sealw resource check --target 1.6.0
sealw test --target 1.6.0
sealw scenario test --target 1.6.0 --release --snapshot
```

正式发布前，完整矩阵必须通过。

## 发布门禁顺序

对每一个已选目标，`package` 会执行：

1. 对 JavaScript 项目同步类型并运行 TypeScript 检查。
2. 检查源码格式、用锁定 esbuild 解析源文件，并运行项目单元测试。
3. 从同一输入独立构建两次，要求完整矩阵的 archive 字节完全相同。
4. 对每个目标运行全部标记为 `"release": true` 的场景，并比较其已提交快照。
5. 构建受所有目标能力上限约束的 staging archive，检查资源和 manifest。
6. 用锁定 source-core compatibility 运行 Install -> Enable -> Reload。
7. 检查 `release.artifactPolicy` 的禁止路径与扩展名。
8. 生成确定性 archive、SHA-256 checksum 和发布溯源文件。
9. 在所有输出都准备好后，原子地发布完整文件集。

任何步骤失败都不会在 `release/` 中留下新的半成品。已有同名发布文件也不会被覆盖；递增
`package.version` 后重新发布。

## 发布产物

假设 `packageId` 为 `example/city-prompts`、版本为 `1.0.0`，会产生：

```text
release/
  city-prompts@1.0.0.sealpack
  city-prompts@1.0.0.sealpack.sha256
  city-prompts@1.0.0.sealpack.release.json
```

checksum 使用 `sha256sum -c` 风格的一行文本。`release.json` 绑定 archive SHA-256、原始
`seal.lock` 字节的摘要、目标矩阵、默认目标、核心提交、运行时版本、overlay、补丁和信任
数据。它能说明该 archive 是在哪个已锁定的宿主契约下验证的。

若需要可复现的时间戳，为发布进程设置 `SOURCE_DATE_EPOCH`（Unix 秒）：

```sh
SOURCE_DATE_EPOCH=1767225600 sealw package
```

未设置时，溯源文件使用固定的 `1980-01-01T00:00:00.000Z`，以避免当前时间破坏可复现性。

无需发布即可运行相同的双构建检查：

```sh
sealw repro verify
```

## 可选 Ed25519 签名

`--sign-key` 读取项目目录内的 Ed25519 私钥，并只签名发布溯源文件：

```sh
sealw package \
  --sign-key keys/release.pem \
  --sign-key-id maintainer-2026
```

- 私钥路径必须是项目相对路径，且文件必须存在。
- `--sign-key-id` 只能与 `--sign-key` 一起使用。
- 私钥不会进入 `.sealpack`、checksum、报告或发布 JSON；发布 JSON 只记录公钥、算法、key ID
  和签名值。
- 项目默认 `.gitignore` 忽略 `keys/`；不要提交私钥。

先在非生产版本上验证密钥格式。密钥无法解析时，失败发生在 `release/` 被触及之前。

## 下载验证

下载方必须将 provenance 中的公钥视为声明，而不是信任根。使用组织已分发的公钥和可选的
`seal.lock` 重新验证 archive、canonical Ed25519 签名与锁绑定：

```sh
sealw release verify release/city-prompts@1.0.0.sealpack \
  --provenance release/city-prompts@1.0.0.sealpack.release.json \
  --trusted-key org-release-public.pem \
  --trusted-key-id maintainer-2026 \
  --lock seal.lock
```

## CI 的最小模式

CI 必须使用与本地相同的锁定工具链，并允许首次 `core sync` 访问锁定 mirror。下面示例
假定插件项目已在 `package.json` 中将 sealwrapper 固定为开发依赖，并提交了对应的
`package-lock.json`；在这种项目中，`npx --no-install` 只会执行锁定版本，绝不会临时下载
另一个版本。

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: jdx/mise-action@v2
    with:
      install: true
  - run: mise exec -- npm ci
  - run: mise exec -- npx --no-install sealw doctor
  - run: mise exec -- npx --no-install sealw core sync
  - run: mise exec -- npx --no-install sealw types verify
  - run: mise exec -- npx --no-install sealw typecheck
  - run: mise exec -- npx --no-install sealw resource check
  - run: mise exec -- npx --no-install sealw scenario test --release --snapshot
  - run: mise exec -- npx --no-install sealw package
```

`sealw init` 的纯模板不自动创建 npm 项目。若插件不使用 npm 依赖，可改为在 CI 的前置步骤
中检出、通过 mise 构建一个已固定版本的 sealwrapper，然后从插件根目录调用该 checkout 的
`sealw` 启动脚本。无论选择哪种安装方式，重点是每一步运行同一版本的 CLI。需要 PNG 报告的
job 还应安装 `librsvg2-bin` 或 ImageMagick，以及 Noto CJK 字体以获得稳定的中文字形。

## 工具仓库自身的验证

本仓库与普通插件项目不同：它还要测试 Go API scanner、受管核心 bridge 和全部示例。提交
sealwrapper 本身时使用：

```sh
mise install
mise exec -- npm ci
mise exec -- npm run check
```

`check` 会启用必须的 managed-core 集成测试。仅修改文档时，仍应至少运行 Markdown 链接检查
和 `mise exec -- npm test`；完整 `check` 需要网络、Go 和较长的运行时间。
