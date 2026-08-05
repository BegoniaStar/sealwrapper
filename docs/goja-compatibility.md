# Goja 兼容性扫描

SealDice 执行插件 JavaScript 时使用的是 Goja，不是浏览器，也不是任意一个“支持 ES6”的
JavaScript 运行时。因此，`esbuild` 能以 `es6` 为目标成功输出，只能说明输出语法已被降到该
目标；它不能为缺失的运行时内置对象、较新的正则特性或 Goja 的具体语义提供 polyfill。

sealwrapper 用一份与受管 SealDice 目标绑定的 Goja profile，在构建前尽早指出可以静态确定的
不兼容项；它是运行时冒烟和场景测试的补充，不是替代品。

## 锁定的兼容性基线

当前注册的 SealDice `1.6.0` 目标依赖下列 Goja 版本：

```text
goja v0.0.0-20260216154549-8b74ce4618c5
Test262 cb4a6c8074671c00df8cbc17a620c0f9462b312a
esbuild output target es6
```

profile 定义在 [src/goja-compatibility.ts](../src/goja-compatibility.ts)。它明确绑定目标 `1.6.0`；
没有 profile 的新目标会被拒绝，不能悄悄沿用这个版本的结论。

这里的 Test262 提交是 Goja 在该提交的测试运行器中固定的版本，而不是“当前最新版 Test262”。
这使本工具的诊断基线能随目标核心复现。

## 为什么要单独扫描

这是 JavaScript 运行时项目的常见分层做法：

1. 上游 Goja 以 [Test262](https://github.com/tc39/test262) 验证 ECMAScript 一致性，并在其
   [测试运行器](https://github.com/dop251/goja/blob/8b74ce4618c5/tc39_test.go) 中维护不能运行的
   特性列表；运行器还通过固定的
   [checkout 脚本](https://raw.githubusercontent.com/dop251/goja/8b74ce4618c5/.tc39_test262_checkout.sh)
   取得上述 Test262 基线。
2. 打包器负责可移植语法。正如 [esbuild 的 target 文档](https://esbuild.github.io/api/#target)
   所说明，`target` 只转换语法，不会为缺失的 API 自动加入 polyfill。
3. 面向插件作者的工具将这些已知、可静态识别的运行时缺口前移为确定性诊断，再用真实宿主
   生命周期和业务场景验证运行时行为。

sealwrapper 不会在每次插件扫描时执行完整 Test262 套件：那是 Goja 上游用于验证解释器的
一致性测试，不是对单个插件的行为测试。本项目使用上游锁定基线来维护保守的诊断 profile。

## 三层验证模型

| 层次 | 解决的问题 | 不能证明什么 |
| --- | --- | --- |
| Goja 静态扫描 | 已知不支持的语法、内置对象、方法和正则模式是否进入源码或 bundle | 任意 API 的实际语义、异步时序和宿主 bridge 行为 |
| 宿主冒烟测试 | 包能否经过 Install → Enable → Reload 生命周期 | 具体业务流程是否正确 |
| fake-QQ 场景测试 | 指令、回复、权限、网络 mock 等用户可见行为是否符合预期 | Goja 对所有 ECMAScript 的完整一致性 |

因此，即使 `sealw goja scan` 通过，仍应运行 `sealw test` 和与改动相关的
`sealw scenario test`；发布时再使用完整 `sealw package` 门禁。

## 扫描范围和边界

profile 从 Goja 锁定 Test262 运行器的已知缺口中选择能够可靠静态识别的项目。当前包括：

- 动态 `import()`、`import.meta`、import attributes/assertions；
- `for await ... of`、异步生成器、decorators、`using` / `await using`；
- `Atomics`、`SharedArrayBuffer`、`Temporal`、`WeakRef`、`FinalizationRegistry`、`Float16Array`
  等缺失的全局对象；
- `Array.fromAsync`、`Promise.withResolvers`、`Object.groupBy`、Set methods、
  `RegExp.escape`、`String.prototype.toWellFormed` 等较新的内置 API；
- Unicode property escapes、命名捕获组、重复命名捕获组、`d` / `v` flag 等不兼容的正则特性。

扫描刻意是保守的，并不声称“没有报错的所有 ECMAScript 特性均已支持”。例如动态属性访问、
运行时生成的代码、第三方库的输入相关路径和 Goja 与浏览器之间的语义差异，无法只凭 AST
完全判断。这些应由冒烟测试和场景测试覆盖。

扫描器也只报告有稳定语法或成员路径证据的用法，避免把不相关的普通标识符误判为运行时
全局 API。可检查的规则和 profile 内容以源码为准。

## 使用方式

在含 JavaScript bundle 的插件项目根目录运行：

```sh
sealw goja scan
sealw goja scan --target 1.6.0
```

该命令构建最终 bundle，并扫描实际将进入 archive 的 JavaScript。诊断使用以下格式：

```text
src/index.ts:12:7 goja.promise-withresolvers: Goja does not support Promise.withResolvers
```

其中包含文件、行列、稳定的规则 ID 和说明。请移除该特性、改用已支持的实现，或将功能放在
相应版本的宿主能力范围内；不要通过注释或包装方式绕过扫描。

`build.ecmaTarget` 必须为 `es6`。这是该 profile 的语法基线，配置为其他 esbuild target 会在
构建前失败。

## 何时会自动执行

任何生成 JavaScript bundle 的流程都会扫描最终 bundle，包括 `resource check`、`test`、
`scenario test`、`watch` 和 `package` 的相关构建路径。发布质量门禁还会逐个扫描 `src/` 下的
作者源码，以便在打包前定位问题。直接运行 `goja scan` 的重点是最终 bundle，因此它可以发现
依赖包或 esbuild helper 带入的特性。

相关工作流见[开发与测试](development-and-testing.md)、[场景与报告](scenario-testing.md)和
[发布与 CI](release-and-ci.md)。

## 更新 profile（维护者）

Goja 兼容性结论必须随目标核心一起更新，而不是凭版本号猜测。新增或升级目标时：

1. 先同步并验证受管核心，确认其 `go.mod` 中实际锁定的 Goja pseudo-version 和提交。
2. 检查该 Goja 提交的 `tc39_test.go` 与 Test262 checkout 脚本，记录确切 Test262 基线和
   feature blacklist。
3. 在 `src/goja-compatibility.ts` 新建或更新与目标绑定的 profile，并为每条可检测规则增加
   单元测试；不可可靠检测的能力不要伪装成静态保证。
4. 更新本文档和目标相关的发布说明，随后至少运行 `npm run typecheck`、`npm test`、
   `npm run lint`、`npm run build` 与 `npm run test:package`。

Goja 的[兼容性声明](https://github.com/dop251/goja#features)应作为上游背景资料，而具体的
自动化判断始终以受管核心实际使用的提交和其锁定 Test262 基线为准。
