# 留下作者信息

来自 `examples_ts/002.留下作者信息.ts` 的最小迁移示例。UserScript 元信息不再由作者手写；`seal.config.json` 是唯一的包元信息来源，`sealwrapper package` 会生成 bundle 的 metadata header。

```sh
../../sealw package --target 1.6.0
```
