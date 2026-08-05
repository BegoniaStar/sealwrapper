# 安全与维护

本仓库的安全门禁分为提交到仓库的配置和 GitHub 后台设置两部分。前者可由代码审查验证；后者
必须由仓库管理员完成，不能由本地脚本替代。

## 版本化门禁

- `npm run audit:dependencies` 会阻断 high/critical npm 漏洞。
- `npm run audit:signatures` 验证已安装依赖的 npm registry 签名。
- Dependabot 每周检查 npm 依赖与 GitHub Actions；所有生成的 PR 都应正常走 CI 和审查。
- CodeQL workflow 覆盖 TypeScript 与 Go，但私有仓库只有启用 GitHub Code Security 后才能运行。确认
  权益后设置 repository variable `ENABLE_CODEQL=true`；未设置时 job 会明确跳过。
- 所有第三方 Actions 必须固定到完整 commit SHA。升级 Action 时先核对上游 release，再通过 Dependabot
  PR 更新 SHA。

## 管理员设置清单

在 GitHub 的 `Settings` 完成以下设置：

1. 为 `main` 创建 ruleset：禁止直接推送，要求至少一位审批，推送新提交后撤销旧审批，并要求 `CI / verify`。
2. 使用 [`.github/CODEOWNERS`](../.github/CODEOWNERS) 要求核心路径由维护者审查。
3. 启用 Dependabot alerts、Dependabot security updates、secret scanning 和 push protection。
4. 启用 GitHub Code Security 后设置 `ENABLE_CODEQL=true`，确认两种语言的 CodeQL job 都产生结果。
5. 若私有仓库具备 Enterprise Cloud artifact attestation 权益，设置
   `ENABLE_ARTIFACT_ATTESTATIONS=true` 并验证发布 tarball 与 SBOM 的 attestation。
6. 启用 GitHub private vulnerability reporting，使 [SECURITY.md](../SECURITY.md) 的默认报告通道可用。

不要把 `CI / verify` 与 CodeQL 设为必需状态检查，直到它们至少在默认分支成功运行一次。启用后，
CodeQL 应成为必需检查；artifact attestation 只约束 release，不应阻塞普通 pull request。

## 进程与测试约束

受管 Git/Go 命令、Go API scanner、reply grammar scanner 和插件项目的发布单测都必须使用有界子进程：
有限超时、合并 stdout/stderr 输出上限和 POSIX 后代进程清理。插件项目质量门禁默认给整个 Node
测试进程五分钟；超过限制时发布失败而不是无限等待。

真实受管核心 integration tests 最多十五分钟，因为它会同步锁定源码并执行真实 Install -> Enable ->
Reload；所有仓库测试仍受 CI job 总时限约束。
