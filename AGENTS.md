# Repository Guidelines

## Required Reading For Every Agent
Before modifying this repository, read `docs/开发协作/更名与版本边界.md` and `docs/开发协作/多Agent协作规范.md`. The first document defines the completed DeskRelay → WeRelay rename, the allowed legacy-name contexts, and the active `0.x.x` version line; the second defines mandatory worktree isolation, commit handoff, dirty-worktree classification, release ownership, and post-release cleanup. Also read `docs/开发协作/任务职责与分工.md` when the task may overlap another long-running Agent.

## Project Mental Model
WeRelay extends real local coding-agent sessions to WeChat, LAN web, and an optional public application relay without creating a forked conversation. DeskRelay is the retired product name; a local directory or historical worktree may still contain that name, but it never changes the current product identity or version line. GitHub is the only public distribution source; `werelay` remains the local package identifier used for tarball installation. Do not publish it to npm Registry, return to the historical `2.x` preview line, or reintroduce legacy package names and command aliases.

There are two runtime shapes:
- `werelay` (alias `werelay-daemon`): the preferred long-lived mode. It owns one WeChat connection for one startup working directory, keeps supported Agent slots alive, and switches from WeChat with commands such as `/codex`, `/claude`, `/grok`, `/codebuddy`, `/reasonix`, and `/opencode`. Switching reuses an already connected visible CLI, or opens a new visible CLI when needed.
- Standalone bridges: `werelay-bridge-*` commands run one adapter-specific bridge. They are still useful for focused debugging, but must not run alongside a same-cwd daemon.

Runtime data lives under `~/.werelay` by default. WeRelay copy-migrates missing files once from the former `~/.deskrelay` directory, then fills remaining gaps from `~/.cli-bridge` and older Claude channel locations; only `WERELAY_DATA_DIR` can configure the active directory.

## Project Structure
- `src/wechat`: iLink setup, channel config, long polling, message send, inbound media download/decryption, stale context-token handling, and transport logging.
- `src/bridge`: bridge lifecycle, adapter selection, controller orchestration, approvals, user-input requests, final-reply forwarding, locks, workspace state, process cleanup, and shared formatting.
- `src/bridge/bridge-adapters.*.ts`: adapter-specific Codex, Claude Code, TClaude, Grok, CodeBuddy, reasonix, WorkBuddy, OpenCode, and shell behavior. Keep adapter conditionals here or in closely related companion modules.
- `src/companion`: visible local CLI companion launchers, IPC endpoint files, daemon delegation, and local companion proxy support.
- `src/daemon`: persistent WeChat daemon, daemon IPC, multi-slot switching, visible terminal auto-open, and pre-start cleanup of stale single bridges.
- `src/runtime`: bridge-owned runtime host creation, including the Codex runtime host and legacy adapter runtime wrapper.
- `src/media`: shared media/attachment metadata types.
- `src/commands` and `src/utils`: global command helpers and update checking.
- `bin/*.mjs`: packaged CLI wrappers. These are tracked source files, not generated output.
- `scripts`: release, safety, snapshot, and packaging helpers, especially `check-public-safety.mjs`, `create-public-snapshot.mjs`, and `smoke-global-install.mjs`.
- `test/<area>` mirrors the runtime areas: `bridge`, `companion`, `daemon`, and `wechat`.
- `docs/README.md`: human-friendly documentation entrypoint. User, architecture, collaboration, release, and website documents live in Chinese-named subdirectories.
- `docs/发布/版本记录`: release notes and the release index. Chinese notes are primary; keep matching `-英文.md` notes aligned when preparing a release.

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

## Build, Test, And Development Commands
Install dependencies:
```bash
bun install
```

Source-mode setup and checks:
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

Quality gates:
```bash
npm run lint
npm run typecheck:src
bun test test
npm run build
npm run quality
```

Focused tests:
```bash
bun test test/bridge
bun test test/companion
bun test test/daemon
bun test test/wechat
```

Packaging and global smoke validation:
```bash
npm pack --dry-run --json
npm run smoke:global -- --purge-global --clean-cache
npm run smoke:global -- --purge-global --clean-cache --full
```

The project runs TypeScript directly in source mode with Node 24 strip-types support, but published packages must ship compiled `dist/*.js`. Keep `prepack` and `npm run build` working before any npm release.

## Coding Style
Use TypeScript ESM with strict typing. Match the local style: 2-space indentation, semicolons, double quotes, and explicit `.ts` imports in source and test files. Prefer `camelCase` for values/functions, `PascalCase` for classes/types, and kebab-case filenames such as `bridge-final-reply.ts`.

Keep edits small and behavior-scoped. Do not introduce cross-cutting adapter conditionals unless the surrounding architecture already centralizes that decision. Prefer existing helpers for locks, endpoint files, process cleanup, runtime host creation, transport error formatting, and WeChat prompt formatting.

`bin/*.mjs` wrappers must stay LF-normalized because npm installs them as executable shebang entrypoints. `.gitattributes` pins this; do not ignore or regenerate `bin/`.

## Testing Expectations
Use `bun:test`. Name files `*.test.ts` and place them under the matching `test/<area>` directory.

Add focused regression coverage when changing:
- bridge ownership, locks, stale lock cleanup, daemon takeover, or process reaping;
- daemon switching, visible CLI auto-open, daemon IPC, or same-cwd delegation;
- adapter final replies, session/thread following, approvals, or Codex `request_user_input`;
- WeChat transport, retry classification, stale context-token handling, inbound media download, AES decryption, or attachment prompt injection;
- global command wrappers, package metadata, release scripts, or npm install behavior.

For release-facing changes, run `npm run quality` plus package/smoke checks. For narrow fixes, run the smallest focused test first, then expand to the relevant suite.

## Daemon And Bridge Behavior
`werelay` is the preferred user workflow; `werelay-daemon` is an explicit alias for service definitions and debugging. It binds to its startup cwd; the current daemon does not switch to a different local project directory from WeChat. If a same-cwd daemon is live, every `werelay-*-start` command should delegate to the daemon instead of replacing it.

Daemon startup should clean stale or still-running single-bridge state automatically when possible. Do not push cleanup work onto the user if the code can safely detect and clear stale locks, dead endpoints, peer bridge processes, or orphan OpenCode processes. When changing cleanup logic, update daemon tests and make logs explicit enough to diagnose what was cleaned.

Standalone single bridges must refuse to start when a live daemon owns the workspace. If an endpoint is stale, clear it and continue using existing helper functions.

## WeChat, Attachments, And Transport
Inbound WeChat images and files are downloaded to `~/.werelay/inbound-attachments/<date>/` and forwarded to the selected CLI as local paths in the prompt. This project saves and exposes attachment paths; it does not implement OCR or document parsing inside the bridge.

`sendmessage ret=-2` is a stale WeChat context-token condition, not a generic send failure. Preserve the targeted cache-clearing and user-facing guidance around sending a fresh WeChat message after startup or long idle periods.

Network failures to `https://ilinkai.weixin.qq.com` may be proxy-related even when bridge state is healthy. Node `fetch()` needs appropriate `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and often `NODE_OPTIONS=--use-env-proxy`; keep `NO_PROXY=127.0.0.1,localhost,::1` so local daemon/companion traffic stays direct.

## GitHub Distribution And Local Packages
GitHub is the only public release and version source. The root `package.json` must keep `private: true`; do not run `npm publish`, add Registry publishing configuration, publish compatibility mirrors, or add legacy command aliases back to `bin`.

The package name `werelay` is retained only as the local tarball and installed CLI identifier. npm remains a build tool:
1. Inspect the real diff and identify user-visible and breaking changes.
2. Update `package.json`, `package-lock.json`, `bun.lock`, README, and the current release note when the product version changes.
3. Run `npm run quality`.
4. Run `npm pack --dry-run --json` and inspect the tarball contents and size.
5. Run `npm run smoke:global -- --purge-global --clean-cache`; use `--full` for the full release path.
6. Install and deploy the reviewed `npm pack` tarball; never substitute a Registry download.
7. Verify the GitHub remote SHA and the installed package version.

Do not describe npm Registry as an installation, update, or release channel for WeRelay. Third-party Agent installation commands that legitimately use npm are unaffected.

## Multi-Agent Git And Release Ownership
WeRelay may be edited by multiple Agents at the same time. Every ordinary development Agent must work in its own branch and worktree, preserve existing dirty state, stage only explicitly owned files, and finish with one or more local commits. Development Agents must not push, merge to `main`, create tags, bump the public version, run `npm publish`, deploy shared environments, or perform any GitHub write operation.

The delivery flow has two separate ownership stages:

1. An **experience integration Agent** is the default next owner after a runtime-changing commit. The user does not need to request deployment for every task. The development Agent must hand off its SHA to the single active integration owner; if no owner exists, the current Agent may take the role only after a full repository inventory. Integration and deployment are serialized, so ordinary Agents must never deploy their own branches concurrently or overwrite a newer candidate. The integration Agent runs the complete gates, creates a traceable preview version and tarball, installs that same artifact locally and on the public Relay, and performs real acceptance checks. It must not push GitHub, create a public tag, or call the candidate a formal release.
2. A **public release Agent** may act only after the user explicitly asks to publish a GitHub version. It may publish only the last candidate baseline that completed experience acceptance. Newly discovered commits must not be silently included; they require a new candidate deployment and observation period first. GitHub fetch, public commit, candidate-branch CI, fast-forward `main`, tag, and remote verification still run on the configured publishing server, with no local-push fallback.

Only one integration owner may control a candidate baseline at a time, and only one public release Agent may control a formal version at a time. Either role must inventory every worktree, branch, dirty file, and candidate commit, integrate by explicit SHA in an isolated worktree, rerun validation after conflicts, and never deploy or publish an uncommitted shared working tree.

Chinese release notes are the user-facing source of truth. Write them in plain, non-technical Chinese: describe what users can now do, what visible problem was fixed, whether any action is required, and what limitations remain. Keep class names, fields, file paths, commit SHAs, test commands, and implementation details in the technical report or commit body, not in the public change record. Follow `docs/开发协作/多Agent协作规范.md`, `docs/发布/体验部署与正式发布.md`, `docs/发布/对外发布操作手册.md`, and `docs/发布/版本记录/中文版本说明模板.md`.

## Release Process
- Development completion means a tested local commit followed by an explicit experience-deployment handoff. The user does not need to repeat a deployment instruction, but this is an Agent completion obligation, not an unattended Git hook or background queue. The responsible Agent must not claim deployment until the candidate tarball is actually installed and verified; if credentials, locking, server access, or validation blocks it, report "committed but not deployed" clearly. Documentation-only, test-description, or CI-maintenance commits do not restart runtime services when the packaged runtime is unchanged.
- Experience deployment is not a GitHub formal release. Use a traceable preview version such as `0.3.5-preview.20260826.1`, record the candidate SHA and tarball SHA-256, deploy the same tarball locally and to the public Relay, retain a rollback artifact, and start observation from the last successful deployment.
- If any source or packaged content changes during observation, create a new commit, rerun the complete gates, rebuild and redeploy a new candidate, and restart the observation baseline. Rolling back a service must not delete or rewrite Git history.
- Only an explicit user instruction to publish a GitHub version starts the public release stage. A formal release must be based on the last experience-approved candidate; new Agent commits default to the next candidate and cannot bypass experience acceptance.
- Keep README focused on product relationships and the shortest successful setup; move command matrices and advanced configuration into `docs/`.
- Add one release note for the current public baseline instead of rewriting historical release notes to pretend they used the new name.
- For the public repository, export a privacy-checked snapshot and create a clean Git history; do not push this private development history directly.
- GitHub fetch, commit, push, tag, and remote verification for the maintained public repository must run on the configured publishing server. The developer Mac may validate and upload a privacy-reviewed snapshot to that server over SSH, but must never fall back to a direct GitHub push.
- The publishing server must push the public commit to a one-time candidate branch first, wait for Secret scan plus Linux, macOS, and Windows quality checks, then fast-forward the same SHA to protected `main`. The public release Agent must also verify the latest CI run triggered by the `main` push.
- Protected `main` must keep strict required checks for `Secret scan` and all three quality jobs, with force pushes and deletion disabled. Do not weaken this rule to bypass a failed release.
- The publishing server must use an isolated WeRelay directory, reject non-fast-forward updates, verify the final remote SHA, and avoid touching unrelated server projects.
- If the change only updates repository policy, CI, or release documentation and does not affect runtime files, create a local commit but do not bump the product version or redeploy the Relay unless the user explicitly requests that repository-only content be published.

## Commit And PR Guidance
Use Conventional Commit prefixes such as `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `build:`, and `chore:`. Keep subjects imperative and behavior-focused, for example `fix: preserve daemon visible companion occupancy`.

PRs should describe:
- affected adapter(s) or runtime area;
- user-visible behavior change;
- migration or compatibility impact;
- commands run;
- relevant WeChat output or terminal snippets for approval, onboarding, daemon switching, or message formatting changes.

Before committing, inspect `git status --short --ignored`. Do not commit ignored local runtime state. If the user explicitly wants the double logs committed, force-add `log.md` and `git-log.md`.

## Troubleshooting Workflow For Agents
When behavior is unclear, inspect real state before changing code:
- `~/.werelay/bridge.log` for bridge/daemon runtime events;
- `~/.werelay/daemon-endpoint.json` for daemon ownership;
- `~/.werelay/bridge.lock.json` for single-bridge ownership;
- `~/.werelay/workspaces/<workspace-key>/bridge-state.json` for active adapter/session state;
- adapter-scoped companion endpoint files under the workspace state directory.

Missing WeChat replies usually reduce to one of these questions: did the active adapter emit `final_reply`; was the active turn WeChat-owned; did transport send fail; did stale context-token handling clear the right recipient token; or did daemon switching target a different cwd.

Prefer surgical fixes backed by focused tests. Avoid broad rewrites of adapter flow, transport state, or release docs unless the user explicitly asks for a larger redesign.

## Agent Experience Records
- **不能把“提交后默认部署”的流程约定描述成已经存在的自动部署系统，除非仓库确实有可执行的协调器、串行锁和部署验真。** 用户明确指出其他 Agent 提交后并不会自然让服务器运行新版本；commit 只是交付物，负责当前任务的 Agent 仍必须实际完成整合、安装和验活，做不到时要明确报告“已提交但尚未部署”，否则会让用户误以为线上已经更新。
- **具备多客户端后端的 CLI Agent 应直接共享一个长期 owner，不能让远程端和电脑 TUI 各自启动独立 ACP。** Grok 已验证可用工作区级 `agent leader` 同时承载 ACP 客户端和可见 TUI；共享 socket、稳定 sessionId 和关闭时清理 owner，才能让手机消息实时出现在电脑终端并避免会话分叉。
- **对外说明“支持某个 Agent”时必须分别标明原任务继续、电脑端可见和已打开界面实时同步，不能把能读取历史、启动命令或加载 ACP 会话统称为完整支持。** 这些能力对应不同的数据 owner 和同步强度；混写会让用户误以为手机消息一定进入当前桌面窗口，掩盖真实 owner 边界，并重新制造对话分叉风险。
- **恢复用户明确选择的持久任务失败时必须直接报告不可用，不能自动新建任务或切换到“最近任务”。** 相同界面里静默换成另一个 session 会让用户以为仍在原上下文中继续，实际却已产生不可见分叉；Claude、OpenCode、Grok 和 CodeBuddy 等适配器都要保留原任务身份并让用户决定如何恢复。
- **对外品牌迁移必须同时统一本地安装包标识、公开命令、活动数据目录和环境变量，不能只改界面文案后继续保留旧产品入口。** 半迁移会让 README、安装体验、日志、部署脚本和用户认知长期割裂；破坏性更名应通过主版本升级和一次性旧数据迁移完成，而不是永久保留两套公开名称。
- **开源前不能只检查当前源码，还必须排除所有未经审查的位图、官网草稿和真实聊天截图，并从已审计快照创建干净的公开 Git 历史。** 未跟踪的营销目录同样可能带账号名、任务内容和局域网地址，而旧提交仍会保留已经删除的二进制图片；让当前快照扫描所有位图、让历史扫描检查敏感文件名，并用无历史快照首次发布，才能阻止这些内容永久公开。
- **无分隔符的“任务关键词”必须先确认能匹配真实任务，再当作控制命令。** 这样既支持“任务canvas”快速筛选，又不会把“任务做完后告诉我”这类正常对话误判为任务切换；有空格或冒号时则视为用户明确发出的搜索命令。
- **可变条数翻页必须从当前已展示范围的末尾继续，而不能用新条数重新计算页码起点。** 例如首屏 10 条后发送“下一页20”应展示第 11–30 条；保存起点、条数和历史位置才能避免跳过任务，并让“上一页”准确返回原范围。
- **对运行于 `dist/` 的 LaunchAgent 做完整构建前，要先卸载服务，构建后再加载并验活。** `npm run quality` 会先删除再重建 `dist/`；仅在构建后执行 `kickstart` 仍可能撞上 LaunchAgent 的自动重启窗口，实测会因依赖文件暂时不存在而退出。先 `bootout`、构建完成后 `bootstrap`，再等待健康检查成功，能避免把公网移动端留在离线状态。
- **移动网页选中任务后，浏览器 title 必须跟随当前任务名；只有未选中任务时才回退到 WeRelay 与终端名。** 用户会依靠浏览器标签识别多个任务，固定终端标题会让不同会话无法区分；深链接、异步任务加载、切换和重命名后都要立即同步。
- **后台解析 CLI 命令和启动子进程必须共用同一套用户 PATH。** 只给子进程补 PATH 还不够，因为命令可能在 `resolveSpawnTarget` 阶段就退回裸命令并触发 ENOENT；把 `~/.hermes/node/bin` 等目录同时用于命令解析与运行环境，才能让 CodeBuddy、TClaude 这类由用户级工具链安装的 CLI 在 LaunchAgent 中稳定启动。
- **CodeBuddy 必须由同一个 `codebuddy --serve` 进程同时承载可见界面与 HTTP ACP，不能再启动独立 `codebuddy --acp`。** 实测独立 ACP 即使复用相同 sessionId，仍会形成第二个 live owner，让手机消息无法实时出现在电脑界面；共享一个 serve 进程才能让输入、回复、审批和停止保持同源。
- **移动端深链接可以先乐观显示请求的 adapter，但是否需要切换必须与服务端真实 activeAdapter 比较。** 乐观标签能让首屏立即显示目标终端，同时用 `requestedAdapter !== adapterPayload.activeAdapter` 决定真实切换，可避免把 `?adapter=tclaude` 误判为已经切换；首次切换还要保留 `task` 参数，才能从完成通知直接进入指定终端的指定任务。
- **已认证的移动网页必须先展示稳定的 App Shell，再分步连接终端、读取任务和最近消息。** 某些 CLI 启动需要十几秒；若把 `app.hidden = false` 放在全部异步请求之后，用户只能长时间停留在 Logo 页。实测先展示“正在连接 / 正在读取”占位，再异步填充任务与最近消息，能立即反馈进度且不影响历史消息按需向上加载。
- **macOS LaunchAgent 启动后台守护进程时，运行目录和辅助 app-server 的 cwd 都应放在 `~/.werelay`，真实项目目录通过参数或 RPC 显式传入。** 后台进程直接以 `Documents` 下的项目作为 cwd 时，实测会卡在 `getcwd/open` 或导致 Codex app-server 启动超时；将宿主 cwd 放到 Bridge 自有目录后可以正常启动，同时任务仍使用真实项目上下文。
- **桌面任务或原生待发送队列的请求超时不能直接等同于发送失败，应以真实任务状态、队列持久化状态和回读到的用户消息作为接受确认。** Codex 桌面 owner 可能已经启动 turn 或写入队列，却没有及时返回请求响应；若界面直接标失败并删除已上传图片，会诱导重试、制造重复任务，还会让稍后执行的真实任务读不到附件，因此未确认时必须保留附件并提示查看真实状态。

- **消息导航按钮应固定在消息阅读区右上角，并保持弱化的半透明视觉。** 放在左上角会与菜单和标题形成错误的操作归属，也会偏离用户在内容区右侧浏览上下文的习惯；仅在存在可跳转消息时显示，能减少干扰。
- **只要当前回复尚未完成，就要在消息末尾持续显示明确的处理中动画，但服务端已结束或最新 AI 回复已出现时必须立即清除本地乐观运行态。** 仅依赖顶部状态会让尚未完成的正文看起来像完整答案，而让缺失或不一致的 turnId 把 `localRunSummary=running` 保留到超时，又会使已经完成的任务继续显示三个点；运行、完成、审批和输入状态必须以当前任务和最新消息共同校验，不能让旧乐观状态覆盖可信的结束证据。
- **侧边栏任务的长按菜单只能由可见任务项本身触发，且不能被页面其他区域的残留文本选区或长按后的合成点击打断。** 微信 WebView 可能把覆盖层上的长按命中到右侧正文标题，原生选择变化会关闭刚打开的菜单，用户持续按住后再松手还可能在固定抑制时间过期后触发普通点击并切换任务；仅给任务按钮设置 `user-select: none` 或使用固定时间窗口仍不够。应让整个任务列表统一禁选中、在触摸开始时清除旧选区、拦截任务列表的 `selectstart`，菜单已打开时清理误选区而不是关闭菜单，并用每个任务项的消费式标记无条件吞掉长按后的下一次 click；移动端收起侧边栏还要同时设为 `visibility: hidden` 和 `pointer-events: none`，侧边栏关闭后则保留正文正常复制能力。这很重要，因为菜单必须稳定停留到用户完成重命名或复制 ID，而不能因按住时长和设备事件顺序不同随机消失。
- **移动网页每次发布都必须给 HTML、静态资源和微信任务链接带同一内容版本；HTML 保持 `no-store`，版本化 CSS/JS 使用内容哈希、ETag、Brotli/gzip 和长期 immutable 缓存，并让已打开页面定期检测版本。** 微信内置浏览器会复用旧页面和静态资源，未版本化资源即使声明 `no-store` 仍可能停留旧交互；把易变入口与不可变资源分开缓存，再在前台恢复时按版本自动换页，才能同时缩短加载时间并确保部署后的修复真正到达手机。
- **网页的乐观用户消息必须在真实用户消息出现时立即合并，即使发送请求仍未返回。** Codex 可能先把消息写入真实会话、几十秒后才回复 HTTP 请求；若 `sending` 状态禁止合并，轮询会同时渲染真实消息和乐观消息。应记录发送前用户消息的稳定身份集合，而不是依赖分页内序号，避免分页窗口移动后同一条消息显示两次。
- **移动网页把待发送消息“引导”到当前任务后，必须立即把它迁移为正文里的乐观用户消息，并用原队列消息 ID 与真实记录对账。** Codex 的 steer 调用成功并不保证桌面 transcript 立刻返回独立用户消息；若前端只删除队列项再刷新，用户会看到消息凭空消失。先保留文字、图片数量和“已引导”状态，真实消息出现后再去重，才能同时保证即时反馈、不丢消息和不重复。
- **不能把当前工具的只读沙箱状态表述成“用户没有给完全访问权限”。** Codex 界面权限选择与某一轮实际下发的执行环境快照可能短暂不同步；应分别说明“用户界面已授权”和“本轮工具运行时仍受限”，并引用实际环境状态，避免把系统同步问题错误归因给用户。
- **“已完成”状态只能来自同一个最新 turn 的明确终态证据，`unknown` 绝不能翻译成已完成。** 新用户消息已出现但桌面运行状态尚未同步时，旧摘要若被插到最新消息之后，会让正在处理的任务看起来已经结束；应保留本地运行态直到真实 turn 接管，最新用户消息即使暂时没有 `turnId`，只要位于上一条 AI 消息之后也要隐藏旧终态，并让当前 turn 的运行中进展优先于旧摘要；桌面 owner 只有在 final answer、明确 completed/failed/interrupted 等证据出现后才能给出终态。
- **公网 Relay 的 API 方法白名单必须与移动端真实接口保持一致，并同时更新协议类型、服务端入口和本机命令校验。** 模型切换使用 `PUT /api/tasks/:id/model`；若只允许 GET/POST/PATCH/DELETE，公网网页会在请求到达电脑前返回 404“页面不存在”，而局域网页正常，容易被误判为模型不可用。新增写接口时应增加端到端 Relay 集成测试，验证方法、路径和请求体都原样转发。
- **移动网页的异步操作必须立即反馈，但同一个状态只能保留一处动态进度。** 终端启动、消息转发等操作可能需要数秒到数十秒；如果等接口返回后才反馈，用户会认为点击无效并重复操作，但把“正在连接”同时放在品牌栏、标题、状态栏、列表和内容区又会造成强烈噪声。应先乐观呈现目标，把耗时和转圈集中在唯一状态位，其他区域只保留目标名称或保持安静。
- **同一维护窗口内的守护进程重启通知必须持久化去重，并且只有实际发送成功后才记录时间。** LaunchAgent 在部署、超时恢复或连续拉起期间可能短时间重启多次；每次启动都通知会让用户误以为连接反复故障，而仅做内存去重又无法跨进程生效，因此要把最近成功通知时间写入工作区状态，失败通知则保留到微信上下文恢复后只补发一次。
- **CLI 退出码 0 必须按正常关闭处理，微信端错误要翻译成中文并附上恢复动作。** `code 0` 表示进程正常结束，不应包装成 `worker exited unexpectedly` 或 `fatal_error`；非零退出也不能直接暴露英文内部术语，提示必须说明发生了什么、是否需要担心，以及用户可发送哪个命令重新打开。
- **ClawBot 的当前 Codex 任务必须与桌面端当前任务分开持久化。** 桌面端本地切换频率很高，若共用一个 threadId 会让微信消息悄悄发往错误任务；只有用户在 ClawBot 手动选择任务，或某项完成通知已成功发到微信时，才允许改变 ClawBot 当前任务。
- **ClawBot 的任务列表、稳定编号、数字冒号直发、切换后自动列任务和消息送达回执必须作为所有会话型 adapter 的通用能力实现，且进入任务后要明确说明普通回复会发给当前任务，并支持“任务数字：内容”直发其他任务。** 重复调用桌面端列表接口、为进入任务而打开桌面任务会造成数秒到十几秒延迟，而按 Codex 硬编码又会让其他终端的微信体验缺失；所有提供任务列表和 `sendInputToSession` 的 adapter 都应复用短时缓存、稳定编号快照、翻页以及“数字：内容”/“任务数字：内容”入口，并在进入任务时说明默认去向；消息成功、排队、重复或忙碌时还必须立即给出明确结果并把任务链接放在末尾，避免用户因归属不清或无反馈而重复下发。
- **ClawBot 的全终端列表和单终端列表必须共用运行状态视觉，普通处理中统一显示 `处理中 🟢`。** 同一个任务在总列表有绿点、进入单终端列表后绿点消失，会让用户误以为任务停止或两套列表状态不同；待审批、待输入和异常仍使用文字状态，只有实际处理中显示绿色运行标记。
- **ClawBot 的裸“任务”必须在 daemon 尚未选中 active adapter 时仍可用，并且只聚合当前已连接或电脑上明确正在运行的终端。** `--idle-start` 会让 WeRelay 在线但 `activeAdapter` 为空，如果先执行“尚未选择终端”保护就会吞掉原本的聚合入口；同时枚举所有已安装终端会混入未运行终端的历史任务并造成不必要探测，因此任务列表要先于 active-slot 校验处理，只做轻量、只读枚举且绝不能为列任务自动启动 Agent、恢复持久化会话或调用桌面端 `openThread`，否则用户仅查看列表也会被强制跳到某条 ChatGPT 任务。默认页必须整体按最近更新时间排序，不为每个运行终端保留席位，也不把运行中任务提前置顶；曾实现过“每个终端优先显示最近一条、其余按更新时间补足”的配额式重排，用户明确反馈应全部按最近时间排序，运行状态改由行内 🟢/待审批/待输入 标记表达，此类按终端配额的重排不应再引入。
- **守护进程清理只能识别由 Node 或 Bun 直接执行的真实 daemon 入口，不能按整条命令行是否包含文件名判断。** 部署 shell 会把项目路径和 `werelay-daemon` 文本写进自身命令行，宽泛正则会误杀正在部署的 shell；解析实际运行时与入口脚本并用回归测试覆盖，才能安全接管旧守护进程。
- **macOS LaunchAgent 打开可见终端应让 `/usr/bin/open` 打开自删除的可执行 `.command` 文件，但真实 GUI 验证禁止裸用 `launchctl submit`，普通测试只能验证纯函数或注入假的启动器。** AppleScript 由后台 LaunchAgent 发起时会阻塞，而 `launchctl submit` 又可能把快速退出的 `open` 推断成 keepalive；本次残留任务自动运行 284 次并产生 289 个测试窗口。真实验证必须用 `trap` 无条件移除临时任务、前后核对窗口数，才能既绕开自动化权限又不干扰用户桌面。
- **编译后的 Node 命令行入口不能只依赖 `import.meta.main` 判断是否直接运行，还要比较 `process.argv[1]` 与当前模块路径。** Node 23 中 `import.meta.main` 不可用会让脚本以退出码 0 静默结束，表面上像终端启动成功但永远不会连接；兼容判断已用真实编译产物验证，今后新增入口必须覆盖目标 Node 版本。
- **ClawBot 的任务列表保留稳定序号用于选择和“数字：内容”直发，但进入任务后的消息头只能显示任务名，不能再暴露序号或任务 ID；历史品牌 `codex-clawbot` 必须迁移显示为 `WeRelay`。** 序号是短期导航坐标，不是用户理解消息归属所需的信息，把它和 UUID 放进审批、桌面输入、完成通知等消息头会制造技术噪声并让旧品牌继续外泄；列表负责导航，任务消息只负责清楚说明来自哪个任务。
- **内部传输提示不能作为用户消息展示，附件意图识别也不能把“讨论 ClawBot 消息”误判成“发送文件”。** 这类误判会把大段协议文字写进真实对话，既污染上下文又让用户误以为必须理解内部机制；网页应只还原真实请求，只有明确涉及文件、媒体、本地路径或简短发送指令时才注入提示，提示确有必要时必须使用中文和当前平台适用的路径示例。
- **公网移动页自动切换局域网必须先比对手机与电脑的公网出口，再用短时一次性交接令牌建立受来源限制的局域网会话，并保留公网回退。** HTTPS 公网 Cookie 不能复用到局域网 HTTP，盲目替换地址又会在异网或隔离网络中卡死；出口比对减少误判，一次性令牌和只能从原局域网来源使用的短期会话避免暴露密码或把局域网 Cookie 拿到公网复用，失败标记与回退则保证加速失败时仍能继续使用公网。
- **移动网页展示 Codex 的 AI 输出时要保持单一连续正文流，并默认折叠次要的长内容。** 用户是在手机上延续同一个桌面任务，重复“工作过程”、灰色小字、截图传输标签、完整铺开的长代码和过多旧进展都会打断阅读；正文应沿用 Codex 的主文字层级，附件只保留真实请求，长代码与旧进展默认折叠但必须可随时展开。
- **AI 生成的图片必须作为统一消息内容同步到网页和 ClawBot，不能只保留文字或依赖某个终端专属的图片打开入口。** 用户会在手机上延续同一个 Agent 任务；如果图片只存在于 Grok/Codex 等桌面终端的工具结果里，网页就会缺少关键结果，微信也只收到不完整的文字，因此各 Agent 的原生图片记录应先归一为公共消息媒体，网页用受鉴权的不透明地址展示，ClawBot 再按当前轮次去重发送真实图片消息。
- **移动端轮询和任务切换后的 Codex 完成兜底都必须只读 rollout 文件尾部和已缓存的桌面状态，历史专用请求还必须完全跳过桌面实时状态合并，不能为了补消息主动调用 `followThread()`、完整 `thread/read`，或从零回放已有大文件。** 实测 47 MB 会话中，完整桌面订阅会让守护进程瞬时占用约 95% CPU、3.2 GB 内存；从旧任务切换后若完成兜底从文件开头同步读取，也会阻塞网页健康检查和 Relay 长轮询。把首次兜底读取限制在最近 1 MB，并让后续只读新增内容，才能在保留完成回推的同时避免移动网页和设备在线链路被拖死。
- **reasonix 必须使用官方 `serve -resume <原 transcript>` 直接继续原任务，不能复制 transcript 到 WeRelay 状态目录。** 复制历史会产生第二份可写记录，即使初始内容一致也会在后续消息中分叉；直接恢复原文件并让官方 Web UI 与远程入口连接同一个 serve owner，才能保证电脑和手机看到同一任务。
- **Codex 后台审批监控必须对所有 `active` 任务保持 `summary` 订阅，并以 Desktop summary 中的实时 `requests` 作为网页与 ClawBot 的审批真相。** `waitingOnApproval` 和待审批请求本身来自 Desktop summary；如果先依赖这个标记再决定订阅，就会形成循环依赖，而审批 RPC 返回成功也不等于桌面 owner 已真正接受，只有对应 request 从 summary 消失后才能记录绿色结果并移除卡片。实时 request 仍存在时必须覆盖本地旧状态、继续展示并通知；`summary` 只保留状态与请求，不等于移动正文读取时的完整 follow，因此这样既能避免超长会话的大内存问题，也不会让“本任务免审”因假成功或传输异常卡死任务。
- **后台只读任务目录、Relay 预热和 daemon 恢复不能调用会改变 Codex Desktop 当前界面的 `openThread()`。** Relay 会周期性刷新已学习的 `/api/task-board` 等路径；若只读枚举用 `restore` 模式启动临时 runtime，或启动恢复直接打开持久化任务，就会把后台刷新变成用户可见的任务跳转。只读目录应使用无会话恢复的 runtime，持久任务恢复只做 `summary` follow，只有用户明确选择任务、创建任务或执行该任务的写操作时才允许打开桌面任务。
- **WorkBuddy 的远程消息必须进入桌面主进程实际持有的 app-server，并通过 `session:load`、`session:sendMessage`、`session:cancel`、`session:resolvePermission`、`session:rejectPermission` 操作，禁止回退到独立 ACP；普通方式启动且缺少 hook 时，用户显式切换应使用真实 bundle id `com.tencent.workbuddy.mac` 自动重启接入，并清理失去父进程的旧 app-server。** 即使独立 ACP 复用了同一个 sessionId 和数据库，它仍是另一个 live owner，消息能运行却不会出现在 WorkBuddy 桌面界面；错误 bundle id 又会让已授权的自动重启无法退出真实应用，只有使用实际安装标识并确保只保留一个 app-server owner，才能让消息、运行状态、审批和回复同步到桌面、网页与 ClawBot。
- **macOS 上供 WorkBuddy 与 WeRelay 共用的 Unix socket 必须使用稳定的 `/tmp/werelay-workbuddy-<uid>.sock`，不能分别依赖各进程的 `os.tmpdir()`。** GUI 应用与 LaunchAgent 可能解析出不同的 `/var/folders/...` 临时目录，导致 socket 明明存在却被误判为“桌面尚未接入”；固定本机私有 socket 路径并设置 `0600` 权限，才能让重启后的守护进程可靠重连且不开放网络端口。
- **新增 `BridgeAdapter` 可选能力时必须同步检查并转发所有 RuntimeHost 包装层，不能只改 adapter 和调用方。** Daemon 实际持有的是 `LegacyAdapterRuntime`；如果包装层漏绑新方法，源码类型仍可通过且 adapter 单测也会成功，但运行时能力会悄悄变成 `undefined`，导致加速历史无法补图片等只在真实部署出现的问题，因此要为“缺失时保持 undefined、存在时保持 this 绑定并正确转发”各写回归断言。
- **网页中的用户输入图片必须和 AI 输出图片共用同一套可点击预览，并在乐观消息被真实历史替换后继续可见。** 只让上传缩略图短暂显示会导致发送成功、刷新页面或重启服务后图片消失，用户无法回看自己给 Agent 的关键上下文；移动端输入图片应持久记录到对应 adapter、任务和 turn，历史读取时恢复为受鉴权的公共消息媒体，同时输入框缩略图也应直接打开全屏预览。
- **移动网页合并加速历史与原生实时消息时必须按跨来源的稳定消息序列对齐，并在历史进入状态、缓存恢复和最终渲染三层过滤来源内部占位消息。** OpenAgentLog 可能没有原生 `id`、`turnId`、`phase`，还会插入 `[tool_use]`、`[tool_result]` 等 Codex Desktop 本来不展示的记录；原生实时页也可能从更早的位置开始。若按数组追加或窄重叠匹配，乐观消息被真实消息替换后就会跳位和重复；若只依赖原生尾部替换占位符，原生页尚未返回、分页未对齐或旧缓存恢复时仍会把内部记录显示给用户。应使用忽略缺失元数据但尊重明确冲突的序列对齐、以原生页替换已对齐区间，并只隐藏 assistant 文本精确等于这些占位符的整条消息，不能误删正常正文中提到 `tool_use` 的内容。这很重要，因为网页记录必须与桌面端可见对话一致，同时兼顾缓存加速和正常技术讨论。
- **官网演示截图必须省略项目名、避免任务列表产生孤字换行，并保留完整手机状态栏；电脑端与移动端配图还要使用同一批任务和逐字一致的续派消息。** 这些细节直接决定用户能否一眼理解“移动端接力原任务”，也能避免营销图暴露无关工作区信息或显得像拼接假数据。
- **微信审批推送失败时必须区分“没有检测到审批”和“iLink context token 已失效”，并在下一条微信消息刷新 token 后先补发仍有效的审批，再处理新消息。** 长任务经常超过微信主动回复窗口；如果先执行用户的新输入或静默丢弃，审批可能继续卡住，用户也会误以为 WeRelay 没监控到任务。
- **微信收到只含正整数的消息时绝不能把它作为普通提示词发送给模型。** 纯数字高度可能是在回复最近的审批选项或任务序号；应先让真实待审批请求获得优先权，再按当前稳定任务列表解析，仍无法确定时明确询问并说明没有转发给模型，否则模型会把“4”之类控制回复误当成新需求，既污染原会话又错过用户真正想操作的任务。
- **Codex Desktop 摘要订阅中的审批请求即使缺少 `turnId`，也必须重建成可操作的网页与 ClawBot 审批。** 摘要状态会保留 `requests` 和 `waitingOnApproval`，却可能省略 turn 历史且请求参数本身没有 turn 标识；若把 `turnId` 当成创建审批卡片的前置条件，就会出现侧边栏显示“审批”但正文没有卡片。审批回复真正依赖的是 thread 与 requestId，因此未知 turn 只能省略展示锚点，不能丢弃请求。
- **给运行中的 LaunchAgent 部署本地 npm 格式安装包时必须安装 `npm pack` 产出的 tarball，不能直接 `npm install -g <仓库目录>`。** 直接安装目录会把全局包变成指向工作区的软链接，后续 `npm run build` 删除并重建 `dist/` 时就可能让正在运行的服务短暂失去入口；先卸载服务、打包并安装 tarball、再恢复服务和验活，才能让开发目录与线上运行副本保持隔离。
- **网页审批结果必须按 Agent、任务和 turn 持久化并重新合并进消息流，不能在清空待审批卡片后只保留短暂 Toast。** 审批卡片消失并不代表用户不再需要确认自己的选择；记录允许、拒绝、任务级允许或免审结果，并在刷新后恢复到对应轮次附近，才能避免用户误以为操作未生效，也能防止结果串到其他任务。
- **WeRelay 的敏感运行时写入必须统一经过私有目录与原子私有文件 helper，并在启动时递归修复旧数据权限。** 只在个别调用点传 `mode` 会遗漏已存在文件、原子临时文件和迁移复制内容；POSIX 上统一目录 `0700`、普通敏感文件 `0600`，并跳过符号链接，才能避免凭据、上下文令牌、日志和附件因 umask 或历史版本遗留而被同机其他用户读取。
- **Codex 完成通知必须把待发送正文、分段进度和成功去重键持久化，发送前只能标记 in-flight，不能提前标记 delivered 或清理 final reply。** 微信 context token 可能在长任务结束时失效，且多段消息可能只成功一部分；只有全部文本送达后再清缓存，并从未送达分段继续补发，才能同时避免通知永久丢失和重复发送，daemon 重启后也能恢复。若恢复连接时有三条或更多完全未发送的完成通知，必须合并成一条按北京时间倒序排列的摘要，写清完成时间、任务名和网页版链接，摘要成功后再批量确认 delivered；否则一次用户输入会触发大量历史回答逐条轰炸。
- **用某个 nvm 目录下的 `npm` 绝对路径执行安装时，仍必须把同目录的 Node 放到 `PATH` 最前面。** `npm` 的入口使用 `#!/usr/bin/env node`，只指定 `.../bin/npm` 仍可能由另一套 Node 运行并安装到错误的全局前缀；先固定 `PATH`、再核对 `npm prefix -g` 和最终命令解析，才能确保 LaunchAgent 使用的是真正验收过的副本。
- **macOS 打包给 Linux 使用的公开快照时必须设置 `COPYFILE_DISABLE=1`。** 否则 BSD tar 会把扩展属性编码成 `._*` AppleDouble 文件，Linux 解包后这些文件会进入 Git 候选列表并触发隐私审计；禁用 copyfile 元数据并在服务器检查不存在 `._*`，才能保证上传内容和本机审计快照一致。
- **Codex Desktop 的 follower 写请求必须同时匹配当前桌面应用的 IPC 方法版本和参数结构，不能只复用旧字段名。** ChatGPT Desktop 26.818.41509 已把 `thread-follower-start-turn` 升到 v2，并把正文与模型放到 `turnStart.request`；继续发送 v1 或旧 `turnStartParams` 会分别造成 Router 等到超时、或 Desktop 读取空请求报错。桌面应用更新后应先从当前 `app.asar` 的协议版本表和 owner handler 核对契约，再用会拒绝错误版本/结构的测试与真实 turnId 验收，才能避免 ClawBot/网页显示“未确认”却没有任何消息进入原任务。
- **移动网页新建任务必须把“桌面 thread 已创建”和“用户已发送第一条消息”分成两个生命周期。** 第一条消息发出前，要按 Agent 复用同一个未完成草稿，并让任务列表轮询在暂时找不到真实 thread 时仍保留当前草稿，不能回退到运行中任务；否则会自动跳转、重复创建空任务，并丢失用户输入到一半的文字和图片。
- **移动网页秒开必须同时使用浏览器本地缓存和 Relay 服务器预热缓存，且内容变化校验必须是按 adapter + threadId 隔离的 O(1) 修订号读取，不能在 `/sync-state` 内再次读取 Agent 历史。** 同源浏览器曾成功认证且可信标记仍有效时，应先同步展示 24 小时内、排除图片 Base64、审批内容和令牌的本地缓存；电脑连接公网 Relay 后，还应通过设备认证的只读 GET 权限，在无浏览器访问时提前刷新终端、任务看板、任务列表和最近任务尾页，并以会话隔离、内存有界、短 TTL 的方式保存。daemon 应在消息、进展、审批、队列和运行态事件变化时递增有界修订号，重启时更换 epoch；页面只在修订号变化后拉完整消息，并在唯一状态位显示“检查更新 / 同步更新 / 已是最新”。这样首次进入、跨设备和电脑短暂离线都能快速显示，又不会让 2.2 秒轮询反复触发昂贵历史读取、制造新 owner 或泄露其他会话。
- **ClawBot 公网任务链接应优先使用 Relay 持久化的短别名，并保留旧可逆短码作为兼容入口。** 直接把 adapter 与 UUID/sessionId 全量编码进 URL 仍然太长；用设备密钥派生稳定短别名、在 Relay 私有持久化 adapter + sessionId 映射，并在电脑离线和 Relay 重启后继续解析，才能同时兼顾手机阅读、跨终端隔离和历史链接可用性。
- **微信任务列表和帮助文案不要用横向分隔线制造区块感。** 手机窄屏里标题、列表和操作提示本身已经足够区分层级，额外的长横线只会增加视觉噪声和消息长度。
- **ClawBot 任务列表里的网址、邮箱、本地路径和文件名必须去链接化并限制标题长度。** 微信会自动把域名、扩展名和地址识别为可点击链接，长提示词还会挤占整屏；仅在列表展示层把相关标点改为不可识别的全角字符并截成短摘要，既能保留任务识别信息，又不会改变真实任务标题、搜索索引或任务路由。
- **DeepSeek Harness 网页 Host 的 `/api/events.mux` 必须按 WebSocket 下行连接，不能当作普通 HTTP SSE 读取。** 真实 `dsh web` 对 HTTP 请求会返回 426，导致消息仍可由历史轮询恢复但审批永远收不到；使用 `ws://127.0.0.1:<port>/api/events.mux` 并保留历史补偿，才能同时覆盖实时审批和断线完成恢复。
- **微信长轮询和入站附件下载的超时必须覆盖完整响应体读取，不能在只收到 HTTP 响应头后就清除 AbortController 计时器。** `fetch()` 会在响应头到达时提前 resolve，若此时关闭计时器而 `res.text()` / `res.arrayBuffer()` 卡住，daemon 进程与网页健康检查仍显示在线，但 ClawBot 入站轮询会无限停住且没有错误日志；把计时器保留到响应体完成并用“响应头已到、响应体停滞”的本地服务器回归测试验证，才能保证最迟在超时后重新轮询而不是静默漏消息。

- **后台 WeRelay daemon 的在线状态与某个 Agent Host 的运行状态必须分开判断。** `dsh web` 只代表 DeepSeek Harness owner 在本机可用；公网网页还依赖 WeRelay daemon 主动建立 Relay 连接，因此排障时要分别检查 Harness 端口、本机 `/health` 和公网 `deviceOnline`，不能看到 Harness 进程就断言移动端应当在线。
- **长期后台 daemon 的启动、自动恢复和健康重试不能自行拉起桌面应用，但用户明确点击网页终端、发送 ClawBot 切换命令或选择具体任务时可以按需打开。** 自动恢复 Codex/WorkBuddy 会把单个 slot 的异常放大成抢焦点和保活重启循环；使用 `--idle-start --no-open` 先保持微信、网页和 Relay 在线，把“后台自动拉起”与“用户主动打开”分开，只有需要启动阶段自动打开时才使用 `--open-desktop-apps`。
- **Harness Host 属于已经存在的共享 owner，不需要再打开 companion 终端，默认切换应恢复其真实任务而不是新建任务。** 把 `harness_host` 当成普通 `shared_service_owner` 会多开无用终端并把切换判为失败；创建 DeepSeek slot 时直接连接 `dsh web`、使用 restore 模式，才能继续电脑上正在运行的同一任务。
- **Codex 桌面 IPC 模式的 metadata app-server 必须优先使用当前 ChatGPT/Codex.app 包内自带的 `Contents/Resources/codex`，只有内置文件不可用或用户显式指定命令时才回退 PATH。** LaunchAgent 的静态 PATH 可能仍指向旧 nvm 或 WorkBuddy 副本，即使桌面应用已经更新；跟随应用包内二进制才能让协议版本同步更新，并避免再次出现桌面端与守护进程运行不同 Codex 版本。
- **已经由 `KeepAlive` 托管的 WeRelay daemon 不能再让基于公网 `deviceOnline` 的第二个 watchdog 拥有强制重启权。** 公网 Relay 的短时离线不等于本机 daemon 损坏，双重监督会把网络抖动放大成 daemon、app-server 和桌面连接重启；公网健康只应用于告警，进程存活交给唯一的 LaunchAgent owner。
- **Codex 桌面模式的独立 app-server 是 metadata 辅助通道，不是桌面任务 owner；它可以与桌面 app-server 通过 SQLite WAL 并存，运行期退出时只能重启或降级自身，不能据此重启 ChatGPT 或整个 daemon。** 现场同时打开 `state_5.sqlite` 的两个 app-server 已稳定共存，旧日志中的 `code 0` 又常与 LaunchAgent 停止信号同时出现；把它误判成 SQLite 单写者冲突会错误删除任务列表、历史、重命名和新建任务所依赖的 RPC 通道，而短暂关闭宽限与独立恢复才能消除假 `fatal_error`。恢复期间还必须把每次 RPC 连接绑定到启动它的 helper，并且只能关闭该次尝试自己的 socket；否则旧连接循环会误关已经恢复的新 socket，造成约十秒后的二次 helper 重启。

- **跨平台实现与测试必须按目标操作系统显式选择路径 API、命令启动器、IPC 类型和权限模型，不能让当前宿主平台的默认行为参与模拟。** Windows 的长路径与 8.3 短路径应先规范化或用 `realpath` 比较，`.cmd`/`.bat` 应通过 `cmd.exe` 启动，Unix Socket 与 Named Pipe 要分开覆盖，敏感文件在 Windows 依赖 ACL 而不是 POSIX mode；否则同一功能会在真实 Windows Runner 上被字符串、入口或权限语义误判，造成整条 CI 持续标红。
- **终端切换菜单只显示需要用户处理的状态，正常的“已打开 / 已连接 / 未打开”不应持续占据每一行。** “已打开”只是检测到进程存在，“已连接”才表示 WeRelay 已接入真实任务 owner；这一区别适合内部诊断，但普通用户只需要看到“当前、切换中、处理中、待审批、待输入、启动中、异常”，否则重复状态会增加噪声并挤压终端名称。
- **所有会进入公开仓库或本地发布 tarball 的职责文档都必须使用基础设施角色名，不能写真实公网 IP 或本地任务 ID。** 即使源码本身没有密钥，服务器地址和内部任务标识仍会暴露个人基础设施与使用轨迹；公开文档应写“专用发布服务器 / 正式公网 Relay”等角色名，真实值只留在本地私有配置中。
- **Codex 新任务从私有 app-server 交接给桌面端时，必须先 `thread/unsubscribe` 释放 active writer，再让 Desktop `thread/resume`；顺序不能反过来。** `thread/start` 会让创建任务的 app-server 持有唯一 writer，若先打开桌面任务，Desktop 会持续报“已在另一个应用中打开”，而原实现又因打开失败跳过 unsubscribe，形成永久占用；桌面不可用时再显式恢复 bootstrap writer，才能兼顾唯一 owner 与锁屏继续任务。
- **官网首屏必须使用真实产品界面或以真实截图为高保真参考，不能凭空虚构 Codex、DeepSeek Harness 等桌面 Agent 的信息架构；视觉关系仍应明确表达“多个电脑 Agent → WeRelay → 手机 ClawBot / 网页控制台接力”。** 错画成终端或自造导航会误导产品形态；电脑窗口应紧密重叠，手机与网页入口要成为清晰接力终点，局域网与外网则是同一网页控制台的两种可选连接方式，这对准确建立用户预期很重要。
- **用户要求“收集研究网上的设计”时，必须围绕行业案例与通用评价方法展开，不能擅自转成对当前项目资产的诊断。** 研究对象一旦被替换，即使分析很详细也没有回答用户的问题；应先覆盖外部案例、专业评审标准和可复用的判断框架，再在用户明确要求时应用到现有方案。
- **ClawBot 用户可见的任务链接必须保持真正短链、只在 Relay 确认持久化后发送，并作为消息最后一段独占一行。** 未确认时既不能发可能 404 的别名，也不能把内部可逆长链接当作用户短链；链接后继续拼接“发送全文”等说明会让微信把 URL 与正文识别成同一段而无法点击，因此所有说明必须放在链接前，最终消息以短链结尾；注册失败则应移除内部链接并明确提示用户从“任务”列表进入，这对同时保证链接可靠、可点击和简洁体验很重要。
- **移动网页等待连接时必须区分“服务器可达但电脑未连接”和“服务器本身不可达”，并持续展示动画、等待时长或重试次数。** 固定显示“等待电脑连接”会把备案拦截、Relay 故障和电脑离线混成同一种状态，让用户无法判断系统是否仍在工作；分阶段状态既能减少误判，也能给出正确的排查方向。
- **移动网页必须区分“请求正在到达电脑”“电脑正在转交对应终端”和“终端已接受并开始处理”。** 在终端确认前就显示“正在处理”会让传输等待看起来像模型推理，并让发送失败长期没有解释；分阶段状态、幂等发送标识和可查询投递结果能避免重复提交并准确说明卡在哪一层。
- **DeepSeek Harness 的失败原因要从 `turn/end.reason.error` 等嵌套字段提取，新建空白任务首次发送图片时要选用可用的视觉模型。** DSH 会在文本模型收到图片时直接拒绝 prompt，也会把 OpenRouter 空响应写进嵌套错误；若只读顶层 `reason.message` 或继续使用文本模型，用户只能看到笼统失败，既无法判断是图片能力还是模型服务异常，也无法正确重试。

- **DeepSeek Harness 模型菜单必须展开 `session.models.groups` 的全部 provider，不能只显示当前会话的 provider。** 同一个 DSH 安装可同时加载 DeepSeek、Tencent、OpenRouter、OX Alpha 等来源，而不同 provider 还可能复用相同 model id；用 `provider::model` 作为内部选择键、用“来源 · 模型名”展示并兼容旧裸 model id，才能让每个会话都看到完整可选模型并精确切换。
- **非 Codex 终端的已连接运行态应优先于可能滞后的任务列表 idle 快照。** DSH 等 Host 的会话摘要可能晚于实时事件更新；若把旧 idle 当成绝对状态，任务明明在处理却不会显示通用呼吸绿点。Codex 仍以桌面 owner 状态为准，其他终端则在当前任务 busy、待审批或有活动 turn 时覆盖旧 idle，才能让所有终端的运行提示及时一致。
- **Agent 进展被压缩成通用短句后必须按同一 turn 的“类型 + 可见文案”保留最新一条，不能只按原始事件 ID 去重。** 多个不同 reasoning、命令或 rollout/live 事件可能分别映射成“规划下一步处理”“运行并检查测试”“已运行命令”等相同文案；继续逐条展示不会增加信息，只会让用户误以为任务重复执行。语义去重应发生在截取最近活动之前，并覆盖原生状态、rollout 与两者合并后的结果，才能既保留最新状态又避免噪声挤掉真正不同的进展。
- **全终端任务列表必须为每条任务稳定显示用户可识别的终端名，有真实项目归属时也必须同时显示项目名。** 即使当前分页恰好只有一个终端，隐藏终端名也会让用户误以为其他终端任务被混入或丢失；只有通过 `/codex`、`/dsh` 等明确筛出的单终端列表才可以省略重复终端名，且消息前缀必须使用 `DeepSeek Harness`、`Claude Code` 等产品名而不是内部 adapter id。
- **DSH Desktop 2.0.3 返回 HTTP 403 不代表任务不存在；只有用户从网页或 ClawBot 明确切换到 DSH 时，WeRelay 才应启用兼容模式和本机回环浏览器访问并重启 DSH，然后只连接恢复后的 Desktop 端口。** 后台任务枚举不能擅自修改设置或重启桌面应用，也不能回退到 3080 端口的独立 `dsh web` owner；把主动修复限定在显式切换，可同时避免任务分叉、意外打断用户和把本机管理接口暴露到公网。
- **WorkBuddy Desktop 启动恢复不能把持久化任务 ID 当作终端连接成败，旧任务删除或运行时拒绝加载时应清除该 ID，并立即保留“已连接但未选任务”的 slot，而不是依次探测最近任务。** WorkBuddy 的 SQLite 目录会包含多个后台运行或已失效任务，但桌面 renderer 未必能立即加载它们；逐个探测会把网页连接拖慢到数十秒。终端连接本身已足以支持列表和历史读取，用户真正进入或发送某个任务时再精确加载，才能同时保证连续性、速度和状态准确。
- **手机打开本地页面或文件时，应采用“每次点击重新生成有界静态快照”的应用层部署，而不是把本机端口做成公网代理。** 已验证可行的组合是：本地文件只允许当前工作区、回环页面只抓取同源静态资源、Mac 通过既有设备认证 Relay 上传、服务器使用短期内存存储和已登录会话、最终页面放进无同源沙箱；这样既能保证手机看到点击当下的最新版本，又不会把任意本地文件、端口或任务台权限暴露给预览页面。
- **从移动网页在 Codex 项目内新建任务时，必须把来源任务的桌面项目归属转换为 app-server 的规范 `projectId` 并随 `thread/start` 提交，不能只继承 `cwd`。** 用户可能把工作目录位于项目根目录之外的任务手动归入项目，只按路径创建会让新任务落入“无项目”；同时还要把 app-server 项目 ID 反向映射为桌面项目名，保证 Codex 与移动任务台刷新后归属一致。
