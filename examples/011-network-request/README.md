# 网络请求

来自 `examples_ts/011.网络请求.ts`。锁定的 test-only bridge 会拒绝任何网络权限，以保证 Install → Enable → Reload 和 scenario 都不访问外网；因此迁移版的 `.musicsearch [关键词]` 只生成并展示原示例会请求的 URL，不会发送请求。可将该 URL 交给独立、经过授权的服务处理。
