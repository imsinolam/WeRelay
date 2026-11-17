# WeRelay Agent 规则入口

本文件只保留仓库级硬约束；详细命令、运行文件和历史经验按文末入口查阅。始终使用中文对话。每个 Agent 修改仓库前必须完成基线检查和最新状态检查，不以本文件的简写代替项目文档。

## 立即检查

- 现行产品是 WeRelay；`DeskRelay is the retired product name`。历史目录名和旧分支只用于迁移或补丁溯源，不能改变产品身份。修改前读 `docs/开发协作/更名与版本边界.md` 和 `docs/开发协作/多Agent协作规范.md`；任务可能与其他 Agent 重叠时再读 `docs/开发协作/任务职责与分工.md`。
- 在目标 worktree 根目录运行 `npm run baseline:check -- --active`，确认包名为 `werelay`、版本为 `1.x`、HEAD 是活动运行基线的后代，并记录完整基线 SHA。旧工作树缺少命令不是豁免；从最新本地 `main` 新建独立 worktree 移植功能意图。不得推进 `refs/werelay/active-baseline`，不得用 `--no-verify` 绕过共享 pre-commit 守卫。
- 检查 `git status --short --branch`、`git worktree list --porcelain`、`git log` 和所有 worktree 中与本任务重叠的提交。每项需求只有一个 owner，使用独立分支与 worktree，只显式暂存本任务文件；不覆盖、重置、清理或提交他人的工作。

## 工作与交付

开发 Agent 必须自测通过、精确提交、组合最新本地 `main`、串行安全快进合入并核验完整需求 SHA 与 main SHA，才算完成交付。合流使用 `docs/开发协作/多Agent协作规范.md` 的短期锁和 compare-and-swap 流程，不覆盖他人提交；只有用户明确要求才部署或发布。尚未合入 `main` 的需求保留给原负责人，不随版、不阻塞发布。

发布 Agent 只从已合入的本地 `main` 锁定范围；GitHub 公开先在发布服务器推送一次性候选分支，等待 `Secret scan`、`Quality (ubuntu-latest)`、`Quality (macos-latest)`、`Quality (windows-latest)` 全部通过后，才由单一负责人将同一 SHA 快进到受保护 `main` 并完成远端验真。具体步骤以[对外发布操作手册](docs/发布/对外发布操作手册.md)为准。`Only an explicit user request starts a batch deployment`；体验部署和 GitHub 公开分别授权。开发 Agent 不改版本号、不部署、不 push、不建 tag、不从 Mac 直写 GitHub。

所有新版本统一 `1.x.x`，只递增末位；`do not create new preview/rc versions`。同一版本只对应一个已提交的源码树和唯一 tarball，已打包、部署或上传后不得覆盖为不同内容；公开仓库走隐私审查后的无历史快照和 `one-time candidate branch`，发布服务器完成 fetch、push、tag 与远端验真。

GitHub 是 WeRelay 唯一的公开发布和版本来源；本地包标识 `werelay` 只用于自建 tarball 与安装。根 `package.json` 保持 `private: true`，禁止 `npm publish`、Registry 发布配置、兼容镜像和旧命令别名。

同一对话必须只有一个 live owner：远程端与电脑可见终端共用长期 owner，切换应恢复原任务；明确选择或已持久化的任务失败时直接报告不可用，不能自动新建任务或切到“最近任务”制造分叉。远程端和桌面端体验强度必须分别说明。

工具权限和真实体验必须如实区分：只读沙箱不等于用户拒绝授权；真实 Agent/ClawBot 使用由用户验收。敏感运行时文件使用私有目录与原子私有 helper，不提交凭据、运行日志、真实聊天或未审查素材；公开文档只写基础设施角色名。

## 按任务查阅

| 何时查阅 | 入口 |
| --- | --- |
| 需要安装、运行、测试、构建命令 | `docs/开发协作/Agent维护指南_基础命令与环境.md` |
| 修改 TypeScript、测试或质量门禁 | `docs/开发协作/Agent维护指南_编码风格与质量门禁.md` |
| 排查 daemon、WeChat、附件或状态文件 | `docs/开发协作/Agent维护指南_运行时检查与排障.md` |
| 准备发布、隐私快照或 GitHub 操作 | `docs/开发协作/Agent维护指南_发布与隐私检查.md` |
| 确认仓库边界、目录职责或文档维护 | `docs/开发协作/Agent维护指南_多Agent协作与文档维护.md` |
| 涉及共享、发布与品牌迁移的历史经验 | `docs/开发协作/共享与发布经验.md` |
| 涉及 Agent slot、任务归属与持久化 owner | `docs/开发协作/Agent_Slot与任务归属经验.md` |
| 涉及微信、ClawBot、任务列表与消息送达 | `docs/开发协作/微信与ClawBot体验经验.md` |
| 涉及移动网页、API、Relay 与网络体验 | `docs/开发协作/Web终端与网络体验经验.md` |
| 涉及 LaunchAgent、PATH、权限与隐私 | `docs/开发协作/部署运维与隐私安全经验.md` |
| 涉及任务完成态、运行状态与审批同步 | `docs/开发协作/完成任务与运行状态经验.md` |
| 涉及 DSH、DeepSeek Harness 与模型菜单 | `docs/开发协作/DSH_DeepSeek与Harness经验.md` |

经验文档来自本文件迁移前的完整原文，逐条保留 `AGENTS.md:<行号>` 溯源标记；发现旧经验与现行规则冲突时，以 `docs/开发协作/多Agent协作规范.md`、`docs/开发协作/更名与版本边界.md` 和 `docs/发布/` 下的现行事实真源为准，并在对应专题登记冲突，不静默删除。
