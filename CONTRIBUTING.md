# Contributing to WeRelay

感谢你愿意参与 WeRelay 的改进。这个项目连接 WeChat iLink、本地 CLI agent、可见终端 companion 和本地运行状态，很多问题只有在真实系统中才能复现。提交 issue 或 pull request 时，请尽量提供可验证的现象、命令和日志片段。

## Before You Start

- 所有 Agent 必须先阅读 [多 Agent 协作规范](docs/开发协作/多Agent协作规范.md)，再开始修改。
- 文档入口见 [WeRelay 文档导航](docs/README.md)。开始修改前还应阅读 [DeskRelay 更名为 WeRelay：名称与版本边界](docs/开发协作/更名与版本边界.md)，不要根据本机旧目录名或历史 `2.x` 分支误判当前产品和版本。
- 先阅读 [README.md](README.md)，确认当前推荐的使用方式。
- Agent 前置安装见 [docs/使用指南/Agent安装与配置.md](docs/使用指南/Agent安装与配置.md)。
- 运行配置见 [docs/使用指南/运行配置.md](docs/使用指南/运行配置.md)。
- 公网 Relay 部署见 [docs/架构设计/局域网与公网访问.md](docs/架构设计/局域网与公网访问.md)。
- 常见问题和已知限制见 [docs/使用指南/问题排查.md](docs/使用指南/问题排查.md)。
- 源码运行、测试和打包说明见 [docs/开发协作/开发与测试.md](docs/开发协作/开发与测试.md)。

## Fork and Pull Request Workflow

如果你没有 `imsinolam/WeRelay` 的写权限，请从 fork 提交 PR。这里的 `origin` 指你的 fork，`upstream` 指官方仓库。

首次参与时：

```bash
git clone https://github.com/<your-github-name>/WeRelay.git
cd WeRelay
git remote add upstream https://github.com/imsinolam/WeRelay.git
git fetch upstream
```

每次开始一项新改动时，从最新官方 `main` 新建分支：

```bash
git checkout main
git pull --ff-only upstream main
git push origin main
git checkout -b fix/opencode-session-start
```

分支名用 `<type>/<short-topic>`，让 reviewer 一眼能看出范围：

```text
feat/daemon-switching
fix/codex-approval-routing
docs/contributing-guide
test/opencode-session-start
```

完成修改后，先检查改动范围，再提交并推送到自己的 fork：

```bash
git status --short
git add <changed-files>
git commit
git push -u origin fix/opencode-session-start
```

然后在 GitHub 上创建 PR：

- `base repository`: `imsinolam/WeRelay`
- `base branch`: `main`
- `head repository`: 你的 fork
- `compare branch`: 你的工作分支，例如 `fix/opencode-session-start`

如果 review 后继续修改，直接在同一个分支继续 commit 并 `git push`，原 PR 会自动更新。一个 PR 尽量只解决一个清晰问题。

## Reporting Issues

提交 bug issue 时，请尽量包含：

1. 使用的命令，例如 `werelay`、`werelay-codex-start`、`werelay-claude-start` 或 `werelay-opencode-start`。
2. 使用的 adapter：Codex、Claude Code、TClaude、Grok、CodeBuddy、reasonix、WorkBuddy、OpenCode 或 shell。
3. 操作系统、Node.js 版本、包版本和安装方式。
4. 期望行为与实际行为。
5. 最小复现步骤。
6. 相关日志片段，通常来自 `~/.werelay/bridge.log`。

请在贴日志前删除账号凭据、token、完整微信用户标识、私有文件内容和不希望公开的本地路径。不要上传 `~/.werelay/account.json`、`sync_buf.txt`、`context_tokens.json` 或其他登录状态文件。

## Development Setup

需要：

- Node.js `>= 24.0.0`
- Bun `>= 1.0.0`
- 至少一个受支持 Agent；公开开发环境通常使用 Codex、Claude Code 或 OpenCode

安装依赖：

```bash
bun install
```

常用源码命令：

```bash
npm run setup
npm run daemon -- --adapter codex
npm run bridge:codex
npm run bridge:claude
npm run bridge:opencode
npm run codex:start
npm run claude:start
npm run opencode:start
```

## Project Areas

- `src/wechat`: WeChat iLink 登录、轮询、发送、附件下载和传输日志。
- `src/bridge`: bridge 生命周期、状态、审批、用户输入、最终回复和共享格式化逻辑。
- `src/bridge/bridge-adapters.*.ts`: 各 Agent 与 shell 的 adapter 实现。
- `src/companion`: 可见本地 CLI companion、endpoint 文件和 daemon 委托。
- `src/daemon`: 长驻 daemon、多 adapter slot 切换和可见终端自动打开。
- `src/runtime`: bridge 托管 runtime host。
- `bin/*.mjs`: 发布包中的 CLI 入口文件，不是生成产物。
- `test`: 按 runtime area 组织的 Bun 测试。

## Coding Guidelines

- 使用 TypeScript ESM。
- 保持现有风格：2 空格缩进、分号、双引号。
- 源码和测试中的本地 import 保持显式 `.ts` 后缀。
- 优先复用已有 helper，不要为局部问题引入跨 adapter 的大范围条件分支。
- adapter 专属行为尽量放在对应 adapter 文件或紧邻模块中。
- `bin/*.mjs` 必须保持 LF 行尾，因为它们是 npm 安装后的可执行入口。
- 不要提交本地凭据、运行状态、`dist/`、`node_modules/`、日志或本地 artifact 目录。

## Agent Collaboration Workflow

维护者工作区可能同时由多个 Agent 修改。自动化 Agent 与普通 GitHub 贡献者使用不同规则：人类贡献者仍可向自己的 fork 推送并创建 PR；在维护者本机工作的 Agent 只能创建本地提交，不能自行推送或发布。

开发 Agent 必须：

- 使用独立分支和 worktree；
- 开始前检查并保留现有未提交修改；
- 只暂存自己负责的文件，不使用 `git add -A`；
- 完成后提交本地 commit，并报告分支、SHA、改动文件和验证结果；
- 不推送、不合并 `main`、不改正式版本号、不创建 tag、不发布 npm、不部署正式环境。

运行代码完成 commit 后默认交给唯一的体验整合 Agent，自动汇总、打包并部署本机和公网 Relay，不需要用户逐次通知；多个 Agent 不得并发拿各自分支覆盖服务器。这个阶段不推送 GitHub。只有用户之后明确要求发布 GitHub 新版本，唯一的正式发布 Agent 才可以基于已经体验通过的候选准备正式版本号、版本说明和公开发布。完整规范见 [docs/开发协作/多Agent协作规范.md](docs/开发协作/多Agent协作规范.md) 和 [docs/发布/体验部署与正式发布.md](docs/发布/体验部署与正式发布.md)。

## Commit Messages

Commit 第一行使用 Conventional Commit 格式：

```text
<type>[optional scope]: <short English summary>
```

常用 `type`：

- `feat:` 新功能或新能力。
- `fix:` 用户可见 bug 或行为错误修复。
- `docs:` 文档改动。
- `test:` 测试补充或测试修正。
- `refactor:` 不改变外部行为的结构调整。
- `build:` 构建、打包、发布脚本或依赖元数据。
- `chore:` 维护性改动。

摘要用英文，写清楚行为变化。不要使用 `update readme`、`fix bug`、`misc`、`修改一下` 这类无法判断范围的描述。

推荐摘要示例：

```text
fix: route Codex approvals through WeChat
fix: start daemon Claude and OpenCode slots fresh
docs: reorganize public docs and dependency references
test: cover OpenCode stale-session startup
```

普通小改动可以只有一行摘要。涉及运行行为、adapter、daemon、审批、附件、发布流程或较大文档调整时，请写 commit body，并采用项目现有 Git log 的双语格式：

```text
fix: route Codex approvals through WeChat

Implement real Codex approval and user-input routing for WeChat-owned turns. The bridge now auto-approves low-risk requests, forwards high-risk requests to WeChat, and keeps pending user input separate from normal turn output. Regression tests cover approval routing, user-input waiting, and fallback behavior.

实现 Codex 在微信回合中的真实审批和用户补充输入链路。bridge 现在会自动通过低风险请求，将高风险请求转发到微信，并把等待用户输入的状态与普通回复输出分开处理。回归测试覆盖审批路由、用户输入等待和 fallback 行为。
```

双语 body 的写法是：英文段落先说明用户可见变化、关键实现和验证结果；中文段落再说明同一件事，方便中文维护和后续 release note 整理。不要把未运行的测试、未验证的发布状态或猜测性结论写进 commit。

## Tests and Verification

小改动可以先跑最相关的测试，再根据风险扩大范围：

```bash
bun test test/bridge
bun test test/companion
bun test test/daemon
bun test test/wechat
```

通用质量检查：

```bash
npm run lint
npm run typecheck:src
bun test test
npm run build
```

完整质量门禁：

```bash
npm run quality
```

涉及发布包、CLI wrapper、`package.json`、`bin/` 或 npm 安装行为时，还应运行：

```bash
npm pack --dry-run --json
npm run smoke:global -- --purge-global --clean-cache
```

## Pull Requests

PR 描述建议包含：

- 问题背景和用户可见行为变化。
- 影响的 adapter 或 runtime 区域。
- 兼容性、迁移或数据目录影响。
- 已运行的测试命令。
- 如果修改了 WeChat 消息、审批、附件或 daemon 切换流程，请附上关键日志或终端片段。

请保持 PR 聚焦。一个 PR 优先解决一个清晰问题，避免把无关重构、文档整理和行为修复混在一起。

## Public Safety Check

提交前运行：

```bash
npm run privacy:check
```

它会检查待提交文件中的私钥格式、常见服务令牌、非示例用户目录、真实公网 IPv4、运行状态文件和未经审查的文档截图。准备新的公开仓库时还应运行：

```bash
npm run privacy:check:history
```

如果历史检查失败，不要直接推送旧历史；优先从已审计的当前快照创建新的公开历史。issue 和 PR 中也不得包含真实任务名、项目路径、聊天截图、服务器地址、setup 链接或 `~/.werelay` 内容。

## Runtime State and Privacy

默认运行数据目录是：

```text
~/.werelay
```

这个目录包含登录凭据、WeChat 同步状态、上下文 token、bridge 日志、workspace 状态和附件缓存。贡献代码或提交 issue 时，请不要提交这些文件，也不要公开其中的敏感内容。

## Release Notes and Publishing

WeRelay 把体验部署和 GitHub 正式发布分成两个阶段。普通开发 Agent 和 PR 可以修改源码、测试和文档，但不能改正式版本号、创建 tag、部署共享环境或推送维护者仓库。

运行代码完成 commit 后，体验整合 Agent 默认在独立 worktree 按提交号串行整合、运行完整检查、生成预发布 tarball，并把同一产物安装到本机和公网 Relay。用户无需逐次发送部署指令。体验部署不是 GitHub 正式发布，必须报告候选 SHA、tarball 校验值、验活结果和回滚产物。

只有用户之后明确要求“发布 GitHub 新版本”，正式发布 Agent 才能基于最后一个体验通过的候选更新正式版本号和版本说明。新提交不得未经体验直接夹带进入正式版本。WeRelay 只通过 GitHub 公开，仓库设置为不可发布的私有包元数据，任何 Agent 都不得执行 `npm publish`。

中文版本记录是面向用户的主说明，应使用普通、清晰的中文描述用户能感知的变化，不写类名、字段名、文件路径、提交 SHA 和测试命令。技术证据保留在 commit body、候选记录和发布验收报告中。模板见 [docs/发布/版本记录/中文版本说明模板.md](docs/发布/版本记录/中文版本说明模板.md)。

GitHub 的公开 commit、push、tag 和远端验真只能在专用发布服务器完成，不能从维护者 Mac 直接推送，也不能在服务器失败后自动回退为本机直推。完整流程见 [docs/发布/体验部署与正式发布.md](docs/发布/体验部署与正式发布.md)、[docs/开发协作/多Agent协作规范.md](docs/开发协作/多Agent协作规范.md) 和 [docs/发布/对外发布操作手册.md](docs/发布/对外发布操作手册.md)。
