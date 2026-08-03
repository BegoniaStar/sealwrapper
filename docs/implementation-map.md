# Sealwrapper 实现与测试映射

本表把 `sealpack-resource-design.md` 的批准设计映射到本仓库的实现。
当前 registry 只有 SealDice `1.6.0`，但实现按 target registry 设计；每个
未来 target 都必须随 core provenance、bridge overlay、API contract 和 trust
descriptor 一起进入新的 sealwrapper 发布。不会读取裸 JS 制品、`extension.json`
或旧 schema/lock；项目使用 schema v2、锁文件使用 lock v3。工具只操作项目自己的
`.seal/core/<target>/`。

| 设计条目 | 实现模块 | 主要回归测试 |
| --- | --- | --- |
| P0 registry target、schema v2、sealpack-only | `src/pinned-target.ts`、`src/config.ts`、`src/cli.ts` | `tests/unit/target-matrix.test.ts`、`tests/unit/config-stage.test.ts`、`tests/unit/cli.test.ts` |
| 安全资源发现、可选 bundle、manifest 与确定性 ZIP | `src/stage.ts`、`src/build.ts`、`src/archive.ts` | `tests/unit/config-stage.test.ts`、`tests/unit/archive.test.ts` |
| 受管 target-scoped mirror / detached worktree / test-only overlay / provenance | `src/lock.ts`、`src/trust.ts`、`src/core.ts`、`src/bridge.ts`、`src/release.ts` | `tests/unit/core.test.ts`、`tests/unit/target-matrix.test.ts`、`tests/integration/core-bridge.test.ts` |
| bridge 严格资源检查、真实 Install → Enable → Reload | `patches/sealdice-core/1.6.0/0001-test-only-bridge.patch` | `tests/integration/managed-core.test.ts`（设 `SEALWRAPPER_CORE_INTEGRATION=1`） |
| fake QQ、连续场景、CQ 输入、`#{SPLIT}` 多段输出、fail-closed HTTP mock | `src/scenario.ts`、bridge overlay | `tests/unit/p1-p2.test.ts`、`tests/integration/managed-core.test.ts`、`examples/*/tests/scenarios/` |
| QQ transcript、离线 SVG/HTML/PNG、identity cache | `src/identity.ts`、`src/renderer.ts`、`src/reports.ts`、`src/png.ts` | `tests/unit/identity-report.test.ts`、`tests/unit/renderer.test.ts`、`tests/unit/png.test.ts` |
| P1 helpdoc / templates capability | `src/capabilities.ts`、`src/stage.ts`、bridge overlay | `tests/unit/p1-p2.test.ts`、`tests/integration/managed-core.test.ts` |
| P2 SARIF、release provenance、签名与 trust rotation | `src/sarif.ts`、`src/release.ts`、`src/trust.ts` | `tests/unit/p1-p2.test.ts`、`tests/unit/core.test.ts` |
| P2 target-specific TypeScript contract | `tools/seal-api-scan/`、`src/api-contract.ts`、`src/types.ts` | `tests/unit/api-contract.test.ts`、`tests/unit/types.test.ts`、`npm run test:api-scanner` |
| Typed CLI actions, generated help and TTY-only progress | `src/cli.ts`、`src/progress.ts`、`tools/package-cli.mjs` | `tests/unit/cli.test.ts`、`tests/unit/cli-edge.test.ts`、`tests/unit/progress.test.ts`、`npm run build` |
| 统一文本/JSON/JUnit CLI 输出与工具链前置诊断 | `src/output.ts`、`src/xml.ts`、`src/core.ts`、`src/cli.ts` | `tests/unit/cli-edge.test.ts`、`tests/unit/cli.test.ts`、`npm run test:integration:required` |
| 可运行的迁移/混合示例及报告导出 | `examples/`、`tools/test-examples.ts` | `tests/unit/examples.test.ts`、`npm run test:examples` |

## 验证层级

- `mise exec -- npm run check`：build/typecheck、源码 lint、带覆盖率门槛的
  Node 单元测试、Go AST scanner、必需的真实 managed-core 集成，以及全部示例回归。
- `SEALWRAPPER_CORE_INTEGRATION=1 mise exec -- npm run test:integration`：从
  lock 指定 core 源码构建 bridge，验证 parser、资源加载与真实 reload。
- `mise exec -- npm run test:examples`：每个示例同步/审计 core 与类型、运行
  项目单元测试和 release 场景，并导出离线 JSON/SVG/HTML/PNG 报告。

报告只是诊断制品；场景断言和快照始终只比较 bridge 生成的 JSON transcript。
