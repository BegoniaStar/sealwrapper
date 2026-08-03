# LightScript Loader

这是 `sealdice-LightScriptLoader` 的 schema-v2 `.sealpack` 迁移示例。它保留回雪的运行时回复、LightScript TOML 内容包解析、骰点/变量和 `.回雪` 管理命令；不包含旧项目的兼容 target、旧发布脚本或 `extension.json`。

LightScript 索引和内容包位于 `assets/lightscripts/`。运行时只通过这个明确目录中的 JSON 文件加载内容包，绝不扫描磁盘。随附的 `sealwrapper-demo.toml.json` 是一个可运行的最小内容包，发送“回雪素材演示”即可验证它。

```sh
../../sealw scenario test --target 1.6.0 --release --render --png --offline
../../sealw package --target 1.6.0
```

场景 `management-permissions.json` 对同一群聊连续发送管理命令，并验证普通成员与群主无权、非管理员骰主和白名单用户有权。`authorized-runtime-reply.json` 则让骰主写入“今日人品”的运行时代码：它调用海豹骰的 `Lib.jrrp`、保存按用户/日期隔离的状态，并以不同用户的真实消息触发。桥接器在扩展完成注册后才注入配置，所以这里测试的是 core 的真实扩展配置、`Install → Enable → Reload` 和 `ExecuteNew` 路径。
