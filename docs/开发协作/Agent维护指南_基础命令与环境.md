# Agent 维护指南：基础命令与环境

本指南承接根 `AGENTS.md` 移出的日常命令。它是按需命令参考，不定义协作或发布规则；仓库级约束见根 `AGENTS.md`，完整流程见[多 Agent 协作规范](多Agent协作规范.md)和[开发与测试](开发与测试.md)。

## 依赖与源码模式

安装依赖：

```bash
bun install
```

源码模式启动和检查：

```bash
npm run setup
npm run check
npm run daemon -- --adapter codex
npm run bridge:codex
npm run bridge:claude
npm run bridge:opencode
npm run codex:start
npm run claude:start
npm run opencode:start
```

源码模式使用 Node 24 的 TypeScript strip-types 能力；发布包必须包含编译后的 `dist/*.js`。修改构建入口前确认 `prepack` 与 `npm run build` 仍可用。

## 质量门禁与定向测试

完整质量门禁：

```bash
npm run lint
npm run typecheck:src
bun test test
npm run build
npm run quality
```

按影响范围运行定向测试：

```bash
bun test test/bridge
bun test test/companion
bun test test/daemon
bun test test/wechat
```

文档与协作规则改动运行相关文档测试及 `npm run baseline:check -- --active`；产品代码改动按风险选择门禁，发布前按现行发布流程重跑完整门禁。

## 打包与全局安装烟测

```bash
npm pack --dry-run --json
npm run smoke:global -- --purge-global --clean-cache
npm run smoke:global -- --purge-global --clean-cache --full
```

这些命令用于检查打包内容和全局安装行为。发布版本、部署和 GitHub 公开仍须各自授权，详见[体验部署与正式发布](../发布/体验部署与正式发布.md)和[GitHub 正式发布操作手册](../发布/对外发布操作手册.md)。

## 来源说明

迁移前根 `AGENTS.md` 的相关原文位于提交 `baa4823acfe6a6ddeadae9bc3459dd723bf4d31e` 的第 54–98 行。本指南按当前命令入口重写，避免旧切片在 `bun install` 后丢失闭合代码围栏；命令语义可由源提交逐行复核。
