# 实现与测试映射

本页为贡献者提供从用户可见能力到实现模块和回归测试的索引。它不是插件 API 参考；插件作者
应从[从零开始](quickstart.md)和[开发与测试](development-and-testing.md)开始。

当前 registry 只包含 SealDice `1.6.0`，但所有关键流程都按 target registry 设计。项目只
接受 schema v2 与 lock v3，只操作项目自己的 `.seal/core/<target>/`，也不会读取旧的裸 JS
制品、`extension.json` 或用户指定的核心 checkout。

| 能力 | 主要实现 | 主要回归层 |
| --- | --- | --- |
| Schema v2、目标矩阵和 package 配置 | `src/config.ts`、`src/pinned-target.ts` | `tests/unit/config-stage.test.ts`、`tests/unit/target-matrix.test.ts` |
| 确定性 staging、bundle 边界、manifest 与 ZIP | `src/stage.ts`、`src/build.ts`、`src/archive.ts` | `tests/unit/config-stage.test.ts`、`tests/unit/archive.test.ts` |
| lock、镜像、worktree、overlay 与工具链 | `src/lock.ts`、`src/trust.ts`、`src/core.ts` | `tests/unit/core.test.ts`、`tests/integration/core-bridge.test.ts` |
| Bridge 资源检查和真实 Install -> Enable -> Reload | `src/bridge.ts`、`patches/sealdice-core/` | `tests/integration/managed-core.test.ts` |
| fake-QQ、连续消息、CQ 分段、HTTP mock 和断言 | `src/scenario.ts`、bridge overlay | `tests/unit/p1-p2.test.ts`、示例场景 |
| 身份缓存与 JSON/SVG/HTML/PNG 报告 | `src/identity.ts`、`src/renderer.ts`、`src/reports.ts`、`src/png.ts` | `tests/unit/identity-report.test.ts`、`tests/unit/renderer.test.ts`、`tests/unit/png.test.ts` |
| SARIF、发布溯源、签名和安全发布 | `src/sarif.ts`、`src/release.ts` | `tests/unit/p1-p2.test.ts` |
| API inventory、语义声明和类型检查 | `tools/seal-api-scan/`、`src/api-contract.ts`、`src/types.ts` | `tests/unit/api-contract.test.ts`、`tests/unit/types.test.ts` |
| Typed CLI、帮助、进度与机器输出 | `src/cli.ts`、`src/progress.ts`、`src/output.ts` | `tests/unit/cli.test.ts`、`tests/unit/cli-edge.test.ts`、`tests/unit/progress.test.ts` |
| 示例发现与端到端回归 | `examples/`、`tools/test-examples.ts` | `tests/unit/examples.test.ts`、`npm run test:examples` |

## 验证层级

| 命令 | 覆盖范围 |
| --- | --- |
| `mise exec -- npm test` | Node 单元测试，包括 CLI、配置、归档、类型、报告与发布。 |
| `mise exec -- npm run test:api-scanner` | Go AST scanner 自身。 |
| `mise exec -- npm run test:integration:required` | lock 指定核心构建的 bridge 与真实资源/重载路径。 |
| `mise exec -- npm run test:examples` | 每个示例的 core/types、项目单测、资源和 release 场景/离线报告。 |
| `mise exec -- npm run check` | build、lint、覆盖率、scanner、必需 integration 和全部示例的总门禁。 |

报告仅是诊断输出；场景断言和快照始终比较 bridge 产生的 JSON transcript。目标契约和信任
描述符的维护方式见[类型契约维护](type-contract.md)。
