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
