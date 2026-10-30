# Pi Agent 接入边界

本页描述 WeRelay 接入 Pi 的不可妥协条件。原生会话目录索引用于列表和历史读取；只有真实 Pi owner 的进程内扩展建立本机鉴权连接后，才能宣称微信、网页可以操作该任务。

## 已核实的本机协议

本机 Pi CLI（`@earendil-works/pi-coding-agent` 0.87.1）将原生会话保存在 `~/.pi/agent/sessions/<项目>/...jsonl`。会话文件首条 `session` 记录提供 ID 和 cwd；`session_info` 保存名字；`message` 保存消息。Pi 提供 `--mode rpc` 的 JSONL 子进程协议，支持 `get_state`、`prompt`、`switch_session`、`new_session`、`abort` 等命令；`prompt` 被接受并不表示已完成，完成必须等待后续事件。RPC 子进程是**另一个 Pi 进程**，不是对已打开 TUI 的控制通道。

依据：本机安装包中的 `docs/sessions.md`、`docs/session-format.md`、`docs/rpc.md` 和 `docs/rpc-commands.md`。后续实现必须针对实际安装的 Pi 版本再次核验。

## 同一个 owner，不能复制会话冒充连接

- 微信、网页给已在 Pi TUI 中运行的任务发送消息，必须交给**该 TUI 持有的 owner**，而不是另起 `pi --session <文件> --mode rpc` 写同一 JSONL。文件 ID 相同不代表内存中的上下文、待执行工具和审批一致；两个写者可能分叉或损坏会话。
- 对已打开的 TUI，应通过 Pi extension 在那个进程内建立**仅本机、已鉴权**的 owner 入口；extension 负责把消息交给 `pi.sendUserMessage()`，报告当前真实 session、状态、事件与审批。不能在用户不知情时注入现存进程；未安装/未加载 extension 时，明确显示“需要从 WeRelay 启动 Pi 或在 Pi 中加载扩展”。
- 对 WeRelay 主动创建的会话，由可见 Pi TUI 做唯一 owner，进程内扩展接收远程请求。进程退出后才能按 Pi 官方的原生 session ID/路径恢复；找不到原文件要报错，不能新建替代任务。
- 列表、消息、审批、停止、模型、推理强度与微信数字直发均以 `adapter=pi + sessionId` 为身份，符合现有跨终端索引协议。

## 接入完成的验收条件

1. Pi 原生会话目录能按项目与最近更新时间列入全局任务列表，大小写无关的 `/pi` 只在 adapter 确实可连接时成功；没有 owner 时不能伪装在线。
2. 已接入的本地 Pi 任务通过微信/网页发送后，Pi 本地界面能看到同一条用户消息及后续回复；反向本地消息也同步到网页；完成、排队、失败状态明确。
3. 同 sessionId 在不同 adapter 不串线；切换、重启后恢复原会话，找不到/正在被另一 owner 持有时拒绝分叉。
4. 图像、审批、取消、原生命令按实际协议逐项测试；未实现的能力在 provider 声明和 UI 中保持不可用，不用假成功占位。
5. 包含跨平台、权限、并发重复发送、长会话读取和真实 Pi CLI 集成测试，构建与打包后再做桌面/微信/移动网页验收。

## 网页新建与模型预选（2026-10-17）

- 后台进入 Pi 仍然只读索引，不为列任务启动 CLI。明确点击新建后，按原任务文件中的真实项目目录寻找已接入窗口；优先原任务的唯一 owner，否则要求项目内只有一个 owner。没有窗口或存在歧义时拒绝，不在别的项目建立替代任务。
- 已接入的交互式 Pi CLI 通过进程内扩展注册的内部命令调用公开 `ExtensionCommandContext.newSession()`；必须显式启用扩展命令解析，控制文字不能作为用户消息发给模型。原窗口忙碌、有队列或编辑区存在未发送草稿时不能切换。
- Pi 1.3.0 的新建会替换整个扩展实例。创建确认取自 `withSession` 的新上下文，之后重连同进程的新扩展，再设置模型/推理强度；不得复用失效的旧上下文。旧 owner 广告在确认响应后清理。
- 草稿模型预选可通过短连接只读获取原窗口目录，或使用本机安装的 Pi SDK 离线读取可用模型。该过程不创建任务、不切换原任务、不发模型请求，也不返回认证数据。预选只在真正的新任务创建后生效。
- **Pi Desktop 原生导入任务与交互式 CLI 不等价。** 当前官方 Desktop native runtime 没有开放 `newSession` 控制；网页明确说明需在桌面新建，不能另起 CLI 写者冒充支持。无已连接窗口的项目仍不能直接远程新建。

验证入口：`bun test test/bridge/pi-*.test.ts`。真实 SDK 隔离验证：

```sh
node --experimental-strip-types test/fixtures/pi/verify-native-new-session.mjs <已安装的-Pi-SDK-file-URL>
```

脚本只使用临时项目与假模型，验证模型目录读取、同一 runtime 内新建、重连后应用模型和推理强度、旧广告清理、零模型网络调用及零用户消息；不覆盖手机、微信或生产 Desktop GUI 验收。普通功能提交不自动安装或部署。

## 运行状态与首次落盘（2026-10-27）

Pi 1.4.0 的真实 SDK 隔离验证确认：异步 `before_agent_start` 准备期间，原 owner 的 `isIdle()` 已经为 `false`，而 `agent_start` 尚未触发；新会话的 JSONL 也可能还未落盘。只监听 `agent_start` 或只枚举磁盘文件，都会漏掉这个阶段的运行状态。

- 扩展在 `before_agent_start`、`agent_start` 上幂等报告同一轮运行，不能重置该轮开始时间。每秒只读核对原 owner 的公开 `isIdle()`，仅状态改变时更新私有广告和已鉴权客户端，不反复写盘。
- 准备失败、恢复空闲但没有正常完成事件时，只清除运行状态，不伪造回复或完成通知。先被状态观察发现的新一轮必须重置上一轮结果，不能沿用上轮失败。
- 全局目录读取唯一活 owner 的状态；首次落盘前，仅当它提供的原生 `sessionFile` 属于当前会话目录时才纳入。落盘后按原生 ID 去重，不创建副本；同 ID 多个 owner 时拒绝猜测。
- 排序使用原生事件时间及原 owner 报告的真实开始/结束时间，不因轮询或窗口打开而不断刷新任务时间。不能把进程存活、文件较新或应用已打开等同于“运行中”。
- CLI 与 Desktop **导入的原生 Pi 会话**共享这套规则，但必须各自加载进程内扩展。Desktop 私有数据库格式不因此获得接入能力，不另起 CLI owner 冒充支持。
- 安装新版 WeRelay 后，旧窗口仍可能持有旧扩展；应在当前任务完成后于 Pi 执行 `/reload`，或由用户正常重新打开窗口。不得为刷新状态自动重启正在运行的任务。

微信列表及网页任务看板统一显示“运行中”；微信运行项带 `🟢`，默认每页 15 条。终端筛选仍使用全局快照编号，显式指定条数及运行任务较多时的既有扩容规则不变，使用说明仍独立一条消息。

回归入口：

```sh
bun test test/bridge/pi-task-runtime-status.test.ts test/daemon/global-task-index.test.ts
node --experimental-strip-types test/fixtures/pi/verify-native-runtime-status.mjs <已安装的-Pi-SDK-file-URL>
```

真实 SDK 脚本只使用临时项目、假模型和同一原 owner，覆盖准备期运行、模型循环运行、完成后空闲及零网络请求；不是生产微信或 Desktop GUI 验收。
