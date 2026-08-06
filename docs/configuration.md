# 项目配置

`seal.config.json` 是插件的唯一配置入口。它使用封闭的 schema v2：未列出的字段会被
拒绝，而不是静默忽略。`seal.lock` 使用 lock v3，记录每个已选目标的完整、签名描述符。

## 完整的混合型示例

下面是一个包含 JavaScript、牌堆、自动回复和静态资源的最小完整结构。省略任何必填对象
都会在读取配置时失败。

```json
{
  "schemaVersion": 2,
  "package": {
    "name": "城市冒险灵感",
    "version": "1.0.0",
    "authors": ["Example Author"],
    "license": "MIT",
    "description": "自动回复和指令共享的冒险灵感牌堆。",
    "homepage": "https://example.invalid/city-prompts"
  },
  "build": {
    "entry": "src/index.ts",
    "ecmaTarget": "es6",
    "bundleFileName": "city-prompts.js"
  },
  "sealDice": {
    "buildTarget": ["1.6.0"],
    "defaultTarget": "1.6.0"
  },
  "release": {
    "directory": "release",
    "checksum": "sha256",
    "artifactPolicy": {
      "forbiddenPaths": [],
      "forbiddenExtensions": []
    }
  },
  "sealpack": {
    "packageId": "example/city-prompts",
    "minSealDice": "1.6.0",
    "contents": {
      "scripts": { "bundle": true, "path": "scripts/city-prompts.js" },
      "decks": { "source": "content/decks" },
      "reply": { "source": "content/reply" }
    },
    "dependencies": {},
    "permissions": {
      "network": false,
      "networkHosts": [],
      "acknowledgeUnrestrictedNetwork": false,
      "fileRead": [],
      "fileWrite": [],
      "dangerous": false,
      "httpServer": false,
      "ipc": []
    },
    "readme": "README.md",
    "assets": [],
    "store": {
      "category": "rules",
      "icon": "",
      "banner": "",
      "screenshots": []
    }
  }
}
```

`$schema` 是可选字符串，适合编辑器提示；`sealw init` 会写入
`https://raw.githubusercontent.com/BegoniaStar/sealwrapper/main/schemas/seal.config.schema.json`。
它不改变当前严格的验证规则，也不能替代 `sealw` 的跨字段校验。

## `package`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | 非空字符串 | 展示名称，也是生成 bundle metadata 的名称。 |
| `version` | 规范 SemVer | 例如 `1.0.0` 或 `1.0.0-beta.1`；数值型预发布标识不能有前导零。 |
| `authors` | 非空字符串数组 | 至少包含一名作者。 |
| `license` | 非空字符串 | 许可证标识或文本。 |
| `description` | 字符串 | 允许空字符串。 |
| `homepage` | 字符串 | 允许空字符串。 |

元数据文本不得包含控制字符。对于含有 `build` 的项目，sealwrapper 会把这些字段写入生成的
JavaScript UserScript metadata header；不要在 `src/` 中再维护一份会漂移的头信息。

## `build` 与 JavaScript bundle

`build` 只在 `sealpack.contents.scripts` 存在时使用；反过来，声明了 `scripts` 也必须有
`build`。

| 字段 | 约束 |
| --- | --- |
| `entry` | 位于 `src/` 下的 JS/TS/CJS/MJS 入口，例如 `src/index.ts`。 |
| `ecmaTarget` | 传递给 esbuild 的目标，例如 `es6`。 |
| `bundleFileName` | 纯文件名，不含目录；必须等于 `scripts.path` 去掉 `scripts/` 后的部分。 |
| `contents.scripts.bundle` | 必须为 `true`。 |
| `contents.scripts.path` | `scripts/` 下的单个 `.js` 文件，例如 `scripts/city-prompts.js`。 |

构建时所有被 esbuild 读取的文件都必须解析到项目根目录以内。符号链接和跨项目导入不能绕过
这个边界。`package.json` 可以保留给项目测试依赖，但如果它存在，项目必须同时提交
`package-lock.json`；两者都不会进入最终 `.sealpack`。

## npm 项目契约与发布元数据

`package.json` 只管理 Node 开发环境，`seal.config.json` 才定义最终 Sealpack；两者不能
互相替代。只要项目包含 `package.json`，sealwrapper 会在 staging 前验证：

- `package-lock.json` 同时存在，且是 lockfile v3；
- lockfile 顶层及 `packages[""]` 的 `name`、`version` 与 `package.json` 相同；
- 根包的 `dependencies`、`devDependencies`、`optionalDependencies`、`peerDependencies` 和
  `peerDependenciesMeta` 与 lockfile 完全相同；
- 若写出 `packageManager`，它必须是规范的 `npm@<semver>`。

这会检测手改 `package.json` 后忘记更新 lockfile 的情况；实际安装树仍应由 CI 中的
`npm ci` 物化和验证。孤立的 `package-lock.json` 同样会失败。

在 `sealw package` 发布前，npm manifest 中重复的发布元数据必须严格等于
`seal.config.json.package`：`version`、`description`、`homepage`、`license` 和作者列表。
作者在 npm manifest 中使用首位 `author` 加其余 `contributors` 表示，顺序必须与
`package.authors` 一致：

```json
{
  "author": "First Author",
  "contributors": ["Second Author"],
  "description": "Same release description as seal.config.json",
  "homepage": "https://example.invalid/project",
  "license": "MIT"
}
```

不要把多位作者合并到一个以顿号分隔的 `author` 字符串。`package.json.name`、
`seal.config.json.package.name` 和 `sealpack.packageId` 分别是 npm 技术名、商店展示名与
Sealpack ID，因此不要求相同。

## 目标矩阵与 `seal.lock`

```json
"sealDice": {
  "buildTarget": ["1.6.0"],
  "defaultTarget": "1.6.0"
}
```

- `buildTarget` 是非空、无重复的已注册目标数组。它是构建、资源检查、测试和发布兼容性
  的唯一来源。
- `defaultTarget` 必须是 `buildTarget` 的成员。当命令只物化一份核心或类型声明且没有
  `--target` 时使用它。
- `sealpack.minSealDice` 必须严格等于矩阵中的最低 SemVer 目标。市场把它解释为
  `>= min_version`，因此新增未来目标前必须重新评估整个发布门禁。

目标并不是任意版本号。当前 registry 仅有 `1.6.0`；新目标必须随 sealwrapper 的新版本
带入匹配的核心来源、桥接能力、API 契约、补丁和签名信任信息。

`seal.lock` 是项目输入，不是缓存。它固定 registry 版本、目标集合、默认目标、核心提交、
镜像策略、测试 overlay 和信任描述符。不要手动编辑它，也不要从另一项目复制目标片段；使用：

```sh
sealw lock update
```

此命令默认要求 Git 工作区干净，并在写入前打印可审查的差异。确实需要在脏工作区迁移时才
使用 `sealw lock update --allow-dirty`。

## 内容根目录

`sealpack.contents` 至少声明一种内容。资源根必须使用固定路径；工具递归收集普通文件并拒绝
符号链接、目录外路径和重复归档路径。

| 内容键 | 配置 | 源目录 | 说明 |
| --- | --- | --- | --- |
| `scripts` | `{ "bundle": true, "path": "scripts/name.js" }` | `src/` 构建到归档 | 可选 JS bundle。 |
| `decks` | `{ "source": "content/decks" }` | `content/decks/` | 牌堆资源。 |
| `reply` | `{ "source": "content/reply" }` | `content/reply/` | 自动回复规则。 |
| `helpdoc` | `{ "source": "content/helpdoc" }` | `content/helpdoc/` | 目标核心支持的 `.json`、`.xlsx` 帮助文档。 |
| `templates` | `{ "source": "content/templates" }` | `content/templates/` | 目标核心支持的 `.yaml`、`.yml`、`.json` 模板。 |

可选的 `assets/` 始终以同名根目录收集，不在 `contents` 中声明。`sealpack.assets` 中的每
一项都必须是最终会被收集到的 `assets/...` 文件。`store.icon`、`store.banner` 和
`store.screenshots` 若非空，也必须指向这些已声明的资源。

所有作者提供的路径必须是以 `/` 分隔的项目相对路径，不能是绝对路径、Windows 盘符路径，
也不能出现空段、`.`、`..` 或反斜杠。

## 权限与依赖

`sealpack.permissions` 中所有字段都必须出现：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `network` | 布尔值 | 是否声明网络访问。默认应为 `false`。 |
| `networkHosts` | 字符串数组 | `network: true` 时允许的主机集合。 |
| `acknowledgeUnrestrictedNetwork` | 布尔值 | `network: true` 且主机列表为空时必须为 `true`。 |
| `fileRead` / `fileWrite` | 字符串数组 | 由 manifest 声明的文件范围。 |
| `dangerous` / `httpServer` | 布尔值 | 高风险能力开关。 |
| `ipc` | 字符串数组 | 由 manifest 声明的 IPC 范围。 |

当 `network` 为 `false` 时，`networkHosts` 必须为空，并且
`acknowledgeUnrestrictedNetwork` 必须是 `false`。即使声明了网络，场景 bridge 仍不会
访问真实网络：它只会执行[场景中精确声明](scenario-testing.md#网络-mock)的 HTTP mock。

`sealpack.dependencies` 是包 ID 到非空版本范围的对象；ID 使用 `作者/包名` 形式。`readme`
当前必须严格为 `README.md`，它必须是项目根目录的普通文件。

## 发布策略与商店元数据

`release` 的字段如下：

| 字段 | 说明 |
| --- | --- |
| `directory` | 项目相对发布目录，例如 `release`。发布时不能通过符号链接逃出项目。 |
| `checksum` | 当前必须为 `sha256`。 |
| `artifactPolicy.forbiddenPaths` | 禁止进入最终归档的完整归档路径。 |
| `artifactPolicy.forbiddenExtensions` | 禁止的扩展名，例如 `.map`；按归档文件的最后扩展名比较。 |

`store` 必须包含 `category`、`icon`、`banner`、`screenshots`。`category` 可以为空；
`icon` 和 `banner` 用空字符串明确表示未提供；截图是 `assets/` 下文件的数组。

## 常见配置错误

| 现象 | 原因与处理 |
| --- | --- |
| `Only schemaVersion: 2 is supported` | 删除旧 schema 字段，使用本页的 v2 结构。 |
| `minSealDice must equal the lowest selected target` | 让 `minSealDice` 等于 `buildTarget` 的最低版本。 |
| `bundleFileName must equal...` | 让 `build.bundleFileName` 与 `scripts.path` 的文件名完全一致。 |
| `Declared resource source does not exist` | 创建对应的固定 `content/<kind>/` 目录并加入至少一个普通文件。 |
| `Declared sealpack asset is not staged` | 将文件放到 `assets/` 下，并使用完全一致的相对路径。 |
| `Symbolic link is not allowed` | 用真实文件替代链接；归档和受管路径都禁止符号链接。 |

下一步请阅读[开发与测试](development-and-testing.md)，了解配置如何进入实际验证流程。
