# 场景、网络 Mock 与报告

场景测试以 JSON 描述 fake-QQ 会话。它的目标是验证用户可观察到的行为：指令回复、自动
回复、状态变化、资源加载和网络请求。场景不会启动真实 QQ 连接，也不会允许插件在测试中
访问真实互联网。

场景文件必须放在 `tests/scenarios/`，扩展名为 `.json`：

```sh
sealw scenario test
```

场景可在顶层添加下列 `$schema`，以获得编辑器补全和即时结构校验。运行时仍由 `sealw` 执行
确定性、正则和跨字段检查。

```json
"$schema": "https://raw.githubusercontent.com/BegoniaStar/sealwrapper/main/schemas/seal.scenario.schema.json"
```

每一个文件都是一个连续会话。bridge 按 `sequence` 顺序发送输入，收集该输入产生的所有输出，
再继续下一条输入。因此可用同一文件验证 storage、冷却时间、运行时注册和多用户交互。

## 最小场景

```json
{
  "release": true,
  "title": "问候指令",
  "clock": "2026-08-01T00:00:00Z",
  "messages": [
    {
      "sequence": 1,
      "qq": "3909311212",
      "nickname": "Alice",
      "text": ".hello Alice"
    }
  ],
  "expect": {
    "outputs": [
      {
        "inReplyToSequence": 1,
        "text": "你好，Alice！"
      }
    ]
  }
}
```

`title` 只用于识别场景。`release: true` 表示它会被
`sealw scenario test --release` 纳入发布门禁。未设置时默认为 `false`。

## 选择与超时

本地调试和 CI 可以精确选择所需场景，不必运行整个目录：

```sh
sealw scenario test --filter permission
sealw scenario test --tag release --tag network
sealw scenario test --timeout-ms 180000
```

`--filter` 是文件名或 `title` 的字面子串匹配。`--tag` 可以重复，所有给出的标签都必须存在；
标签在场景顶层的 `tags` 数组中声明，使用最多 64 个字符的小写字母、数字、`.`、`_`、`-`，且
不得重复。`--timeout-ms` 为每次 bridge 调用设置上限，范围为 1--300000，默认 120000；带
`repeatable: true` 的随机断言会单独进行第二次、同样受限的调用。

## 顶层字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `release` | 布尔值 | 是否属于发布场景。默认 `false`。 |
| `title` | 字符串 | 人类可读标题。 |
| `tags` | 小写标签数组 | 可用 `--tag` 选择；未设置时为空数组。 |
| `clock` | ISO-8601 时间 | 固定场景时钟；默认 `1970-01-01T00:00:00.000Z`。 |
| `seed` | 非负 31 位整数 | 固定随机序列；默认 `0`。 |
| `messages` | 数组，必填 | 依序注入的 fake-QQ 输入。 |
| `users` | QQ ID 到用户对象 | 为多条输入提供默认 nickname、role、variables。 |
| `variables` | 标量对象 | 项目级 fake-host 变量。值只能是字符串、有限数字或布尔值。 |
| `host` | 对象 | fake-host 的骰主和扩展配置。 |
| `network` | 对象 | 允许的 hermetic HTTP mock 路由。 |
| `packages` | `.sealpack` 路径数组 | 与本包一起提供给场景的额外普通归档。 |
| `expect` | 对象 | 输出、transcript、诊断和高级行为断言。 |

没有填写的 `clock`、`seed`、`host`、`network` 和 `users` 都会得到确定性默认值。不要依赖
运行机器的当前时间、随机数或真实网络。

## 输入消息与用户

每条 `messages` 记录至少提供 `text`，也可提供这些字段：

| 字段 | 说明 |
| --- | --- |
| `sequence` | 正安全整数，必须唯一；未填写时按数组位置从 1 开始。执行前会按它排序。 |
| `qq` | 数字字符串 fake QQ ID；默认 `10000`。 |
| `nickname` | 显示名称。 |
| `scope` | `group` 或 `private`。 |
| `timestamp` | ISO-8601 时间；未填写时从 `clock` 按序每秒递增。 |
| `role` | `owner`、`admin`、`member` 或 `bot`。 |
| `variables` | 仅对该输入有效的标量变量。 |
| `user` | 覆盖该 QQ ID 在 `users` 中的默认用户对象。 |
| `segments` | 结构化 QQ 消息段；提供后可以省略 `text`。 |

`users` 的键必须是数字 QQ ID。用户对象可包含 `nickname`、`role` 和 `variables`；消息上的
同名字段优先。下面的例子验证多个身份和连续消息：

```json
{
  "clock": "2026-08-01T00:00:00Z",
  "users": {
    "30001": { "nickname": "普通成员", "role": "member" },
    "30002": { "nickname": "管理员", "role": "admin" }
  },
  "messages": [
    { "sequence": 1, "qq": "30001", "text": ".status" },
    { "sequence": 2, "qq": "30002", "text": ".status" }
  ],
  "expect": { "noOutput": true }
}
```

### CQ 与结构化消息段

`segments` 可包含下列 `type`：`text`、`at`、`image`、`face`、`reply`、`forward`。其中
`text.text` 是字符串，`at.target` 是数字 QQ ID 或 `all`，`face.id` 是字符串或数字；图片和
转发的 URL/路径只是 transcript 载荷，bridge 从不读取或下载它们。

常见的入站 CQ 文本也会被安全地转换为同一模型：

```json
{
  "sequence": 1,
  "qq": "3909311212",
  "text": "[CQ:at,qq=100000].seal help"
}
```

支持的 `at`、`face`、`image` 会变成惯性消息段；未知或不合法的 CQ 会保留为普通文本，不会
获得文件、URL 或适配器语义。

## 输出与 transcript 断言

`expect.outputs` 按输出发生顺序匹配，不是按输入顺序匹配。每一项都是对实际输出事件的子集：

```json
{
  "expect": {
    "outputs": [
      {
        "inReplyToSequence": 1,
        "text": "欢迎回来"
      },
      {
        "inReplyToSequence": 2,
        "textPattern": "^骰出了 [1-9][0-9]*$"
      }
    ]
  }
}
```

- `inReplyToSequence` 是作者设定的输入 ID；输出事件即使因为 `#{SPLIT}` 分成多段，仍会
  指向同一输入。
- `text` 是精确文本断言。
- `textPattern` 是 Unicode 正则字符串，不能与 `text` 同时出现。
- `noOutput: true` 要求整个场景没有任何输出事件。
- `transcript` 是完整 transcript 的递归子集断言，适合验证入站分段、方向和会话元数据。
- `diagnostics` 是 bridge 诊断的有序断言；声明它时，诊断数量也必须完全一致。

对于不稳定的消息，只断言真正稳定的字段。不要把渲染后的 SVG/HTML 作为功能断言；权威数据
始终是 JSON transcript。

## 随机、冷却与优先级

固定 `seed` 后可使用高级断言：

```json
{
  "seed": 17,
  "expect": {
    "random": {
      "inputSequence": 1,
      "oneOf": ["结果 A", "结果 B", "结果 C"],
      "repeatable": true
    },
    "cooldown": { "inputSequence": 2, "outputs": 0 },
    "priority": { "inputSequence": 3, "text": "高优先级回复" }
  }
}
```

`random.oneOf` 断言指定输入的第一条输出属于给定集合；`repeatable: true` 会再执行一次并要求
整个 transcript 完全相同。`cooldown` 检查指定输入产生的输出数；`priority` 检查指定输入的
第一条输出文本。

## Fake-host 设置

`host` 可为依赖权限或扩展配置的插件构造确定性环境：

```json
{
  "host": {
    "diceMasters": ["30003", "QQ:30004"],
    "extensionConfigs": {
      "my-extension": {
        "feature.enabled": true,
        "feature.limit": 3,
        "feature.label": "测试"
      }
    }
  }
}
```

`diceMasters` 的元素是数字或 `QQ:<数字>`，内部会规范化为完整 ID。配置值仅限字符串、有限数
字和布尔值，避免把复杂对象隐式传入宿主。LightScript Loader 的
[`management-permissions.json`](../examples/lightscript-loader/tests/scenarios/management-permissions.json)
展示了同一群中骰主和白名单的连续权限验证。

## 网络 mock

插件若声明 `network: true`，测试仍是 fail-closed 的。请求必须同时满足：

1. URL 的主机已列在 `sealpack.permissions.networkHosts`，或项目明确确认无限制网络；
2. 场景中存在 method、URL、请求 headers、请求 body 都匹配的路由；
3. 请求为 bridge 支持的普通 HTTP；HTTPS CONNECT 不会被放行。

示例：

```json
{
  "network": {
    "routes": [
      {
        "method": "GET",
        "url": "http://api.example.test/search?q=seal",
        "headers": { "accept": "application/json" },
        "response": {
          "status": 200,
          "headers": { "content-type": "application/json" },
          "body": "{\"result\":\"ok\"}"
        }
      }
    ]
  }
}
```

路由 URL 必须是绝对 `http://` URL，method 只能由字母组成，状态码范围为 100--599，所有
headers 和 body 均为字符串。未声明的路由不会回退到真实互联网。参见
[`011-network-request`](../examples/011-network-request/) 中的完整配置与场景。

## 额外包

`packages` 可列出与当前项目归档一同提供给 bridge 的 `.sealpack`。每个路径必须相对于项目
根目录，结尾为 `.sealpack`，存在且为普通文件；符号链接、绝对路径和 `..` 都会在访问核心前
被拒绝。

## 快照

```sh
sealw scenario test --update-snapshots
sealw scenario test --snapshot
```

更新快照前先人工审查 transcript，确认变化是期望行为。单目标场景使用
`<scenario>.json.snapshot.json`；当一次运行选择多个目标时，文件名会加入目标 ID，例如
`<scenario>.json.1.7.0.snapshot.json`，避免不同宿主契约相互覆盖。`--snapshot` 与
`--update-snapshots` 不能同时使用。

## 离线报告与身份缓存

```sh
sealw scenario test --render --offline
sealw scenario test --render --png --theme dark --style compact --members
```

`--render` 会在 `.seal/reports/` 中为每个场景写入：

- `<name>.transcript.json`：冻结后的 JSON transcript；
- `<name>.svg` 和 `<name>.html`：本地可查看的聊天预览；
- `<name>.identities.json`：身份解析来源与警告；
- `<name>.avatars/`、`<name>.assets/`：从 data URI 冻结出的图片；
- `<name>.png`：仅在传入 `--png` 时生成。

报告默认可使用 QQ 公开头像/昵称接口并缓存至 `.seal/identity-cache/`，缓存有效期为七天。场景
作者提供的 nickname 优先于公共昵称；查询失败只产生警告和占位信息，不会修改场景断言数据。
`--offline` 保证不进行身份网络查询。PNG 生成优先使用 `rsvg-convert`，没有时回退到
ImageMagick `magick`。
