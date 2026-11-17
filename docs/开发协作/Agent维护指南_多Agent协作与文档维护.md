# Agent 维护指南：多 Agent 协作与文档维护

本指南承接根 `AGENTS.md` 迁出的仓库背景和文档维护入口。协作流程、冲突处理和发布门禁的唯一事实真源仍是[多 Agent 协作规范](多Agent协作规范.md)；名称与版本边界见[更名与版本边界](更名与版本边界.md)，发布操作见[体验部署与正式发布](../发布/体验部署与正式发布.md)和[GitHub 正式发布操作手册](../发布/对外发布操作手册.md)。本文不复制或改写这些现行规则。

## 修改前读什么

- 任务可能与另一长期任务重叠时，先读[任务职责与分工](任务职责与分工.md)，确认唯一 owner 和能力边界。
- 产品身份、旧名称允许范围和 `1.x.x` 版本线，以[更名与版本边界](更名与版本边界.md)为准；本地目录名为 `DeskRelay` 或存在旧 worktree 不改变现行产品身份。
- worktree、基线、独占 owner、精确提交、安全合流、未合入需求的处理以及发布职责，以[多 Agent 协作规范](多Agent协作规范.md)为准。
- 移动网页、Relay 和公开仓库的部署边界见[架构与数据流](../架构设计/架构与数据流.md)与[公开仓库与官网边界](公开仓库与官网边界.md)。

## 产品与仓库背景

WeRelay 延续真实的本地 Agent 会话到微信、局域网网页和可选公网 Relay，不另建分叉对话。常用形态是长期运行的 `werelay`（别名 `werelay-daemon`）：一个启动目录对应一个 WeChat 连接，通过 `/codex`、`/claude`、`/grok`、`/codebuddy`、`/reasonix`、`/opencode` 等命令切换 Agent slot；切换应复用已连接的可见 CLI，必要时才新开。`werelay-bridge-*` 是单适配器调试入口，不能与同一 cwd 的 daemon 同时运行。运行时数据默认在 `~/.werelay`，旧配置只做一次性迁移，`WERELAY_DATA_DIR` 是唯一活动目录配置。

源码职责：微信传输在 `src/wechat`，桥接、审批、状态和共享格式在 `src/bridge`，具体适配行为在 `src/bridge/bridge-adapters.*.ts`，可见 CLI companion 在 `src/companion`，常驻 daemon 在 `src/daemon`，runtime host 在 `src/runtime`，打包 CLI 包装器在 `bin/*.mjs`。文档入口是 `docs/README.md`；发布的中文说明和索引在 `docs/发布/版本记录`。

## 文档维护

- 一个主题只保留一个事实真源。本文和同目录 `Agent维护指南_*.md`、`*经验*.md` 是根规则的按需索引与历史经验归档；遇到冲突，按[多 Agent 协作规范](多Agent协作规范.md)、[更名与版本边界](更名与版本边界.md)和 `docs/发布/` 下的现行文档处理。
- 经验专题来自迁移前根 `AGENTS.md` 的原文，每条以 `AGENTS.md:<行号>` 标明源行；迁移保留原有事实和失效语境，当前生效指令仍以根规则和现行专题文档为准。
- 移动或改名文档时，同步修复 `docs/README.md`、根 `AGENTS.md`、`CONTRIBUTING.md`、`SECURITY.md`、相关测试和版本说明中的路径。本地链接必须可解析。
- 公开文档不得写真实服务器地址、本地任务 ID、令牌、日志或未审查截图；职责文档使用基础设施角色名。

## 历史切片说明

迁移前根文件的“当前工作基线”“统一版本规则”“当前交付边界”“Required Reading”“Project Mental Model”“Project Structure”和“Build, Test, And Development Commands”已由本文的现行入口和[基础命令与环境](Agent维护指南_基础命令与环境.md)承接，不再重复粘贴旧根全文。迁移前原文可从提交 `baa4823acfe6a6ddeadae9bc3459dd723bf4d31e` 中的 `AGENTS.md` 精确读取；旧文按 2026-11-14 的开发即合流规则解释。
