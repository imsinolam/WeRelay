# Agent 维护指南：运行时检查与排障

> 来源：`AGENTS.md`（main `baa4823acfe6a6ddeadae9bc3459dd723bf4d31e`）原文，按维护场景重新编排。命令和文件路径仅在本文及对应专题查阅，root 入口只保留硬约束和触发链接；行号为源文件原始行号，原文语义与命令保持可追踪。

## 原文 40–53 行

## Runtime State And Files
Default active state is in `~/.werelay`:
- `account.json`, `sync_buf.txt`, `context_tokens.json`: WeChat login and sync state.
- `bridge.log`: combined bridge and daemon runtime log.
- `bridge.lock.json`: single-bridge ownership lock.
- `daemon-endpoint.json`: daemon IPC endpoint.
- `workspaces/<workspace-key>/bridge-state.json`: workspace-scoped bridge state.
- `workspaces/<workspace-key>/daemon-state.json`: daemon adapter/thread restore state and the persistent Codex mobile access token.
- `workspaces/<workspace-key>/codex-panel-endpoint*.json`: adapter-scoped local companion endpoints.
- `inbound-attachments/<date>/`: downloaded WeChat images and files.
- `inbound-message-claims/`: cross-process inbound message deduplication claims.

Do not commit local credentials, runtime state, logs, generated `dist/`, `node_modules/`, or ignored local planning/artifact directories. `log.md` and `git-log.md` are intentionally ignored; only edit them when the user explicitly asks for the repo's double log, and use `git add -f log.md git-log.md` if they must be committed.

## 原文 118–131 行

## Daemon And Bridge Behavior
`werelay` is the preferred user workflow; `werelay-daemon` is an explicit alias for service definitions and debugging. It binds to its startup cwd; the current daemon does not switch to a different local project directory from WeChat. If a same-cwd daemon is live, every `werelay-*-start` command should delegate to the daemon instead of replacing it.

Daemon startup should clean stale or still-running single-bridge state automatically when possible. Do not push cleanup work onto the user if the code can safely detect and clear stale locks, dead endpoints, peer bridge processes, or orphan OpenCode processes. When changing cleanup logic, update daemon tests and make logs explicit enough to diagnose what was cleaned.

Standalone single bridges must refuse to start when a live daemon owns the workspace. If an endpoint is stale, clear it and continue using existing helper functions.

## WeChat, Attachments, And Transport
Inbound WeChat images and files are downloaded to `~/.werelay/inbound-attachments/<date>/` and forwarded to the selected CLI as local paths in the prompt. This project saves and exposes attachment paths; it does not implement OCR or document parsing inside the bridge.

`sendmessage ret=-2` is a stale WeChat context-token condition, not a generic send failure. Preserve the targeted cache-clearing and user-facing guidance around sending a fresh WeChat message after startup or long idle periods.

Network failures to `https://ilinkai.weixin.qq.com` may be proxy-related even when bridge state is healthy. Node `fetch()` needs appropriate `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and often `NODE_OPTIONS=--use-env-proxy`; keep `NO_PROXY=127.0.0.1,localhost,::1` so local daemon/companion traffic stays direct.

## 原文 188–199 行

## Troubleshooting Workflow For Agents
When behavior is unclear, inspect real state before changing code:
- `~/.werelay/bridge.log` for bridge/daemon runtime events;
- `~/.werelay/daemon-endpoint.json` for daemon ownership;
- `~/.werelay/bridge.lock.json` for single-bridge ownership;
- `~/.werelay/workspaces/<workspace-key>/bridge-state.json` for active adapter/session state;
- adapter-scoped companion endpoint files under the workspace state directory.

Missing WeChat replies usually reduce to one of these questions: did the active adapter emit `final_reply`; was the active turn WeChat-owned; did transport send fail; did stale context-token handling clear the right recipient token; or did daemon switching target a different cwd.

Prefer surgical fixes backed by focused tests. Avoid broad rewrites of adapter flow, transport state, or release docs unless the user explicitly asks for a larger redesign.

