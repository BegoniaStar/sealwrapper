# sealwrapper 使用文档

本目录面向两类读者：开发 SealDice 插件的作者，以及维护 `sealwrapper` 目标注册表的
贡献者。先阅读[从零开始](quickstart.md)；只有在确实需要多目标、资源包、网络请求或
目标升级时，再进入相应专题。

## 插件作者路线

1. [从零开始](quickstart.md)：初始化混合插件、注册一条命令、添加场景并发布。
2. [项目配置](configuration.md)：理解 `seal.config.json`、`seal.lock`、内容目录与权限。
3. [开发与测试](development-and-testing.md)：同步核心和类型、资源检查、冒烟测试、SARIF
   与本地 watch。
4. [场景与报告](scenario-testing.md)：fake-QQ 输入、断言、快照、网络 mock 和离线报告。
5. [发布与 CI](release-and-ci.md)：发布门禁、校验和、溯源、签名和自动化验证。

## 维护者路线

- [类型契约维护](type-contract.md)：Go AST inventory、语义声明、审计和受控更新。
- [实现与测试映射](implementation-map.md)：从功能需求定位到源码模块和回归层。

## 阅读约定

- 所有命令使用公开的双词写法，如 `sealw core sync`。CLI 也接受内部的冒号形式，但
  不应把它写进用户文档或脚本。
- 命令默认在插件项目根目录运行，也就是包含 `seal.config.json` 和 `seal.lock` 的目录。
- `.seal/` 是工具生成的受管状态，默认应被 Git 忽略；不要手动编辑其中的核心、声明或
  报告来绕过验证。
- 当前注册表只包含 `1.6.0`。示例中出现的目标值不是任意可替换的版本号；只能选择当前
  安装的 sealwrapper 发布所注册的目标。

## 先检查环境

```sh
mise install
mise exec -- sealw doctor
```

如果 `doctor` 报告 Go 版本不匹配，请使用 mise 提供的 `1.25.0`。系统内安装的更高版本
不会被视为兼容版本。
