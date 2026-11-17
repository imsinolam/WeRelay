# Agent Slot与任务归属经验

> 来源：`AGENTS.md` 原文 `## Agent Experience Records`（main `baa4823acfe6a6ddeadae9bc3459dd723bf4d31e`）。按主题归类，每条均保留原文全文，并在行首标明源文件原始行号；迁移不删除任何一条经验。交叉主题按最接近的一条归档，根规则链接入口统一指向本文。

<!-- AGENTS.md:203 -->
- **具备多客户端后端的 CLI Agent 应直接共享一个长期 owner，不能让远程端和电脑 TUI 各自启动独立 ACP。** Grok 已验证可用工作区级 `agent leader` 同时承载 ACP 客户端和可见 TUI；共享 socket、稳定 sessionId 和关闭时清理 owner，才能让手机消息实时出现在电脑终端并避免会话分叉。
<!-- AGENTS.md:204 -->
- **对外说明“支持某个 Agent”时必须分别标明原任务继续、电脑端可见和已打开界面实时同步，不能把能读取历史、启动命令或加载 ACP 会话统称为完整支持。** 这些能力对应不同的数据 owner 和同步强度；混写会让用户误以为手机消息一定进入当前桌面窗口，掩盖真实 owner 边界，并重新制造对话分叉风险。
<!-- AGENTS.md:205 -->
- **恢复用户明确选择的持久任务失败时必须直接报告不可用，不能自动新建任务或切换到“最近任务”。** 相同界面里静默换成另一个 session 会让用户以为仍在原上下文中继续，实际却已产生不可见分叉；Claude、OpenCode、Grok 和 CodeBuddy 等适配器都要保留原任务身份并让用户决定如何恢复。
<!-- AGENTS.md:213 -->
- **CodeBuddy 必须由同一个 `codebuddy --serve` 进程同时承载可见界面与 HTTP ACP，不能再启动独立 `codebuddy --acp`。** 实测独立 ACP 即使复用相同 sessionId，仍会形成第二个 live owner，让手机消息无法实时出现在电脑界面；共享一个 serve 进程才能让输入、回复、审批和停止保持同源。
<!-- AGENTS.md:231 -->
- **ClawBot 的当前 Codex 任务必须与桌面端当前任务分开持久化。** 桌面端本地切换频率很高，若共用一个 threadId 会让微信消息悄悄发往错误任务；只有用户在 ClawBot 手动选择任务，或某项完成通知已成功发到微信时，才允许改变 ClawBot 当前任务。
<!-- AGENTS.md:238 -->
- **ClawBot 的任务列表保留稳定序号用于选择和“数字：内容”直发，但进入任务后的消息头只能显示任务名，不能再暴露序号或任务 ID；历史品牌 `codex-clawbot` 必须迁移显示为 `WeRelay`。** 序号是短期导航坐标，不是用户理解消息归属所需的信息，把它和 UUID 放进审批、桌面输入、完成通知等消息头会制造技术噪声并让旧品牌继续外泄；列表负责导航，任务消息只负责清楚说明来自哪个任务。
<!-- AGENTS.md:244 -->
- **reasonix 必须使用官方 `serve -resume <原 transcript>` 直接继续原任务，不能复制 transcript 到 WeRelay 状态目录。** 复制历史会产生第二份可写记录，即使初始内容一致也会在后续消息中分叉；直接恢复原文件并让官方 Web UI 与远程入口连接同一个 serve owner，才能保证电脑和手机看到同一任务。
<!-- AGENTS.md:247 -->
- **WorkBuddy 的远程消息必须进入桌面主进程实际持有的 app-server，并通过 `session:load`、`session:sendMessage`、`session:cancel`、`session:resolvePermission`、`session:rejectPermission` 操作，禁止回退到独立 ACP；普通方式启动且缺少 hook 时，用户显式切换应使用真实 bundle id `com.tencent.workbuddy.mac` 自动重启接入，并清理失去父进程的旧 app-server。** 即使独立 ACP 复用了同一个 sessionId 和数据库，它仍是另一个 live owner，消息能运行却不会出现在 WorkBuddy 桌面界面；错误 bundle id 又会让已授权的自动重启无法退出真实应用，只有使用实际安装标识并确保只保留一个 app-server owner，才能让消息、运行状态、审批和回复同步到桌面、网页与 ClawBot。
<!-- AGENTS.md:248 -->
- **macOS 上供 WorkBuddy 与 WeRelay 共用的 Unix socket 必须使用稳定的 `/tmp/werelay-workbuddy-<uid>.sock`，不能分别依赖各进程的 `os.tmpdir()`。** GUI 应用与 LaunchAgent 可能解析出不同的 `/var/folders/...` 临时目录，导致 socket 明明存在却被误判为“桌面尚未接入”；固定本机私有 socket 路径并设置 `0600` 权限，才能让重启后的守护进程可靠重连且不开放网络端口。
<!-- AGENTS.md:271 -->
- **后台 WeRelay daemon 的在线状态与某个 Agent Host 的运行状态必须分开判断。** `dsh web` 只代表 DeepSeek Harness owner 在本机可用；公网网页还依赖 WeRelay daemon 主动建立 Relay 连接，因此排障时要分别检查 Harness 端口、本机 `/health` 和公网 `deviceOnline`，不能看到 Harness 进程就断言移动端应当在线。
<!-- AGENTS.md:272 -->
- **长期后台 daemon 的启动、自动恢复和健康重试不能自行拉起桌面应用，但用户明确点击网页终端、发送 ClawBot 切换命令或选择具体任务时可以按需打开。** 自动恢复 Codex/WorkBuddy 会把单个 slot 的异常放大成抢焦点和保活重启循环；使用 `--idle-start --no-open` 先保持微信、网页和 Relay 在线，把“后台自动拉起”与“用户主动打开”分开，只有需要启动阶段自动打开时才使用 `--open-desktop-apps`。
<!-- AGENTS.md:273 -->
- **Harness Host 属于已经存在的共享 owner，不需要再打开 companion 终端，默认切换应恢复其真实任务而不是新建任务。** 把 `harness_host` 当成普通 `shared_service_owner` 会多开无用终端并把切换判为失败；创建 DeepSeek slot 时直接连接 `dsh web`、使用 restore 模式，才能继续电脑上正在运行的同一任务。
<!-- AGENTS.md:281 -->
- **Codex 新任务从私有 app-server 交接给桌面端时，必须先 `thread/unsubscribe` 释放 active writer，再让 Desktop `thread/resume`；顺序不能反过来。** `thread/start` 会让创建任务的 app-server 持有唯一 writer，若先打开桌面任务，Desktop 会持续报“已在另一个应用中打开”，而原实现又因打开失败跳过 unsubscribe，形成永久占用；桌面不可用时再显式恢复 bootstrap writer，才能兼顾唯一 owner 与锁屏继续任务。
<!-- AGENTS.md:293 -->
- **DSH Desktop 2.0.3 返回 HTTP 403 不代表任务不存在；只有用户从网页或 ClawBot 明确切换到 DSH 时，WeRelay 才应启用兼容模式和本机回环浏览器访问并重启 DSH，然后只连接恢复后的 Desktop 端口。** 后台任务枚举不能擅自修改设置或重启桌面应用，也不能回退到 3080 端口的独立 `dsh web` owner；把主动修复限定在显式切换，可同时避免任务分叉、意外打断用户和把本机管理接口暴露到公网。
<!-- AGENTS.md:294 -->
- **WorkBuddy Desktop 启动恢复不能把持久化任务 ID 当作终端连接成败，旧任务删除或运行时拒绝加载时应清除该 ID，并立即保留“已连接但未选任务”的 slot，而不是依次探测最近任务。** WorkBuddy 的 SQLite 目录会包含多个后台运行或已失效任务，但桌面 renderer 未必能立即加载它们；逐个探测会把网页连接拖慢到数十秒。终端连接本身已足以支持列表和历史读取，用户真正进入或发送某个任务时再精确加载，才能同时保证连续性、速度和状态准确。
<!-- AGENTS.md:296 -->
- **从移动网页在 Codex 项目内新建任务时，必须把来源任务的桌面项目归属转换为 app-server 的规范 `projectId` 并随 `thread/start` 提交，不能只继承 `cwd`。** 用户可能把工作目录位于项目根目录之外的任务手动归入项目，只按路径创建会让新任务落入“无项目”；同时还要把 app-server 项目 ID 反向映射为桌面项目名，保证 Codex 与移动任务台刷新后归属一致。

<!-- AGENTS.md:279 -->
- **终端切换菜单只显示需要用户处理的状态，正常的“已打开 / 已连接 / 未打开”不应持续占据每一行。** “已打开”只是检测到进程存在，“已连接”才表示 WeRelay 已接入真实任务 owner；这一区别适合内部诊断，但普通用户只需要看到“当前、切换中、处理中、待审批、待输入、启动中、异常”，否则重复状态会增加噪声并挤压终端名称。
