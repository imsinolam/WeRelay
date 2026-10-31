# Agent 安装与配置

WeRelay 是 Agent 的远程入口，不包含模型、账号或 Agent 本体。使用前需要先安装目标 Agent、完成首次登录，并确认 WeRelay 进程能够在 `PATH` 中找到对应命令；桌面适配器还需要对应应用已安装并可启动。

## 一、通用准备

### 1. Node.js 与 WeRelay

WeRelay 需要 Node.js `>= 24.0.0`。当前只通过 GitHub 公开源码，没有 npm Registry 公共包；先按 [从 GitHub 安装与更新 WeRelay](GitHub源码安装与更新.md) 完成本地 tarball 安装。

```bash
node --version
```

确认命令可用：

```bash
command -v werelay
command -v werelay-setup
```

Windows PowerShell：

```powershell
Get-Command werelay
Get-Command werelay-setup
```

### 2. 微信登录

```bash
werelay-setup
```

扫码确认后，凭据保存在 `~/.werelay`。这个目录包含登录状态、任务映射、日志和附件，不能上传到 GitHub、网盘或公开 issue。

### 3. 验证 Agent 命令

macOS / Linux：

```bash
command -v codex
command -v claude
command -v opencode
command -v pi
```

Windows PowerShell：

```powershell
Get-Command codex
Get-Command claude
Get-Command opencode
Get-Command pi
```

如果终端提示 `command not found`、`not recognized` 或 WeRelay 报告 `spawn <命令> ENOENT`，说明命令没有安装，或启动 WeRelay 的进程没有继承正确的 `PATH`。先在同一终端中直接运行 Agent，确认可用后再启动 WeRelay。

### 4. 验证局域网移动网页

不配置公网服务器也会有移动网页，但 `werelay-setup` 本身不会启动它。进入项目目录运行：

```bash
werelay --idle-start --no-open
```

本机验证：

```bash
curl -fsS http://127.0.0.1:4396/health
```

第一次设置移动密码时，先在 ClawBot 中发送“任务”并进入一个任务，再发送“状态”，从返回的授权链接打开网页。完整步骤见 [5 分钟启用局域网移动网页](局域网移动网页快速开始.md)。

## 二、Agent 配置矩阵

| Agent | WeRelay 查找的命令/应用 | 首次准备 | WeRelay 入口 |
| --- | --- | --- | --- |
| Codex | `codex`；macOS Codex Desktop | 安装、登录并至少打开一个任务 | `werelay --adapter codex` |
| Claude Code | `claude` | 安装后运行 `claude` 完成登录 | `werelay --adapter claude` |
| TClaude | `tclaude` | 按供应方方式安装并完成登录 | `werelay --adapter tclaude` |
| Grok CLI | `grok` | 按供应方方式安装并完成登录 | `werelay --adapter grok` |
| CodeBuddy | `codebuddy` | 按供应方方式安装并完成登录 | `werelay --adapter codebuddy` |
| reasonix | `reasonix` | 按供应方方式安装并完成登录 | `werelay --adapter reasonix` |
| Pi Agent | `pi` | 安装并在本机配置模型 | `werelay --adapter pi` |
| WorkBuddy Desktop | `/Applications/WorkBuddy.app` | macOS 安装应用并至少创建一个任务 | `werelay --adapter workbuddy` |
| DeepSeek Harness | 桌面端，或 `dsh web` | 保持正在使用的桌面端或网页 owner 运行 | `werelay --adapter deepseek` |
| OpenCode | `opencode` | 安装后运行 `opencode` 完成模型配置 | `werelay --adapter opencode` |

TClaude、Grok CLI、CodeBuddy、reasonix、WorkBuddy 和 DeepSeek Harness 可能来自组织内部或供应商渠道。WeRelay 不提供这些工具的安装包，也不应在公开文档中猜测其安装命令；请使用工具自身的官方或组织内说明。

“可以列出任务”不自动等于“电脑端实时同步”。Codex 与 WorkBuddy 使用桌面原生 owner；DeepSeek Harness 复用正在使用的桌面端或显式指定的 `dsh web` owner；Claude Code、TClaude 使用 WeRelay 连接的可见 CLI owner；OpenCode、Grok、CodeBuddy 与 reasonix 使用电脑界面和远程入口共用的共享服务 owner。完整边界见 [README 的会话一致性矩阵](../../README.md#支持的-agent-与会话一致性)。

## 三、各 Agent 的安装与启动

### Codex

公开版 Codex CLI 可以使用 npm 安装：

```bash
npm install -g @openai/codex
codex
```

首次运行时按 Codex 提示完成登录。官方说明：<https://developers.openai.com/codex/cli>

macOS 上如果使用 Codex Desktop：

1. 安装并登录 Codex Desktop；
2. 在应用中创建或打开至少一个任务；
3. 在对应项目目录启动 `werelay --adapter codex`；
4. 在微信发送“任务”，确认能看到桌面端真实任务。

当前实现中，macOS Codex 模式优先映射桌面端任务；其他系统使用 Codex CLI/app-server 与本地 companion 能力。WeRelay 不会为了远程输入自动切换到一条看不见的替代任务。

单 Agent 调试入口：

```bash
werelay-codex-start
# 或
werelay-bridge-codex
```

### Claude Code

Claude Code 官方安装器：

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude
```

Windows 和其他安装方式见官方设置说明：<https://docs.anthropic.com/en/docs/claude-code/setup>

完成登录后：

```bash
werelay --adapter claude
```

单 Agent 调试入口：

```bash
werelay-claude-start
# 或
werelay-bridge-claude
```

Claude Code 使用交互式终端和 hooks，同步质量依赖 `node-pty`。如果安装时原生模块编译失败，先按 [问题排查](问题排查.md#pty-不可用--回退模式) 修复。

### TClaude

先按供应方方式安装，确保以下命令能够直接启动：

```bash
tclaude
```

然后运行：

```bash
werelay --adapter tclaude
```

也可以使用：

```bash
werelay-tclaude-start
# 或
werelay-bridge-tclaude
```

TClaude 复用 Claude 类型的会话、审批和 hook 机制。自定义配置目录时，应在启动 WeRelay 的同一环境中设置 TClaude 自身要求的变量。

### Grok CLI

先确认：

```bash
grok --help
```

再启动：

```bash
werelay --adapter grok
```

推荐入口：

```bash
werelay-grok-start
```

运行后，WeRelay 会启动一个工作区级 Grok leader，并让可见 Grok TUI 与微信、局域网网页和公网网页共同连接这个 leader。仅调试 bridge 时可使用 `werelay-bridge-grok`，再在第二个终端运行 `werelay-grok`。

如果出现“找不到 grok”，不要反复重启 WeRelay；先修复 Grok CLI 安装或 `PATH`。WeRelay 只能继续本机已有的 Grok 会话，不能代替 Grok 完成账号和模型配置。

### CodeBuddy

先确认：

```bash
codebuddy --help
```

再启动：

```bash
werelay --adapter codebuddy
```

推荐单命令入口：

```bash
werelay-codebuddy-start
```

它会启动一个可见的 `codebuddy --serve` owner；CodeBuddy 界面与 WeRelay 通过同一进程的 HTTP ACP 读写任务，因此手机消息、审批、停止和回复不会进入隐藏的第二个 `codebuddy --acp` 会话。

仅调试 bridge 时可在两个终端分别运行：

```bash
werelay-bridge-codebuddy
werelay-codebuddy
```

如果 CodeBuddy 使用自定义配置目录或认证变量，需要在启动 daemon 的同一终端或服务配置中设置。

### reasonix

先确认：

```bash
reasonix --help
```

再启动：

```bash
werelay --adapter reasonix
```

推荐单命令入口：

```bash
werelay-reasonix-start
```

它会启动官方 `reasonix serve` owner。选择已有任务时，WeRelay 直接使用 `serve -resume <原 transcript>` 恢复原文件；官方 reasonix Web UI、微信和移动网页共同连接该服务，不会把历史复制到 WeRelay 私有目录后另开会话。

仅调试 bridge 时可在两个终端分别运行：

```bash
werelay-bridge-reasonix
werelay-reasonix
```

可选变量：

```text
REASONIX_HOME
REASONIX_STATE_HOME
WERELAY_REASONIX_OPEN_WEB=0
```

前两个变量用于定位 reasonix 自己的状态目录；最后一个变量用于禁止自动打开官方 Web UI。原 transcript 不存在或无法读取时，WeRelay 会明确报告任务不可用，不会复制历史或创建替代任务。

### WorkBuddy Desktop

当前 WorkBuddy Desktop 适配器面向 macOS。使用前：

1. 安装 `/Applications/WorkBuddy.app`；
2. 打开应用并完成登录；
3. 在 WorkBuddy 中创建至少一个任务；
4. 运行 `werelay --adapter workbuddy`。

也可以使用独立入口：

```bash
werelay-bridge-workbuddy
```

WeRelay 连接的是 WorkBuddy Desktop 的本机任务和 transcript。应用未安装、未启动或尚无任务时，会提示先在桌面端准备，而不是创建一条云端替代会话。

### Pi Agent

先在电脑终端确认 `pi --version` 可用，并按照 Pi 自己的说明配置模型。建议在目标项目目录运行：

```bash
werelay-pi-start --cwd /你的项目目录
```

它会打开可见的 Pi TUI，并加载 WeRelay 的本地 owner 扩展。微信发送 `/pi` 或 `/pi agent`（不区分大小写）查看 Pi 集合；微信和移动网页发送的文字由扩展交给**同一个原会话进程**。`werelay --adapter pi` 和微信 `/pi` 只读取任务目录，不会为了取列表新开一个空 Pi 窗口，也不等待某个 companion 就绪。历史任务按 Pi 自己的 JSONL 文件索引，不复制会话。

如果 Pi 原窗口已经打开，不要再用 `pi --session` 启动第二个进程。先在电脑上运行一次 `werelay-pi-enable`，然后在**原 Pi 窗口**输入 `/reload`。WeRelay 会通过该窗口进程内的扩展连接原任务；其他项目中打开的 Pi 不会阻止当前项目接入。

**安全边界**：历史任务仍按原生会话文件读取；文件相同不等于已连接原窗口。原窗口没有加载扩展时，WeRelay 会拒绝另起第二个写者。要从已接入的普通 Pi 窗口新建或切换任务，请先在那个窗口操作，再刷新手机页面。扩展仅创建限当前用户访问的本机连接；原窗口不在线、任务身份不一致或 owner 不唯一时均拒绝发送，不会偷偷创建替代任务。Windows 暂不支持接管已打开的普通 Pi 窗口。

**Pi Desktop 复用**：桌面端的原生 Pi 会话与 CLI 使用同一份记录，在 `/pi` 中按原生会话 ID 合并，不列成两个终端。桌面显示 ID 可以解析回原任务；一个桌面运行进程中持有多条原生会话时，扩展分别公布连接，发送仍精确匹配所选任务。桌面原任务运行时必须加载同一 WeRelay 扩展；仅在桌面列表中看见历史不代表它已有发送接口。`PI_CODING_AGENT_SESSION_DIR` 优先指定会话目录，否则使用 `PI_CODING_AGENT_DIR/sessions`，默认 `~/.pi/agent/sessions`。

Pi Desktop 自建任务使用单独的 **Pi Desktop** 入口（见下节），不能把它们的 ID 当作 CLI 原任务恢复。桌面中展示的原生 Pi JSONL 仍属于 Pi Agent 集合。更多边界和维护验收见[Pi原生会话与桌面复用](../架构设计/Pi原生会话与桌面复用.md)。

当前只承诺文字任务和停止运行；图片、审批回传以及从微信执行 Pi 自有斜杠命令暂不开放。Windows 暂不自动恢复历史任务，因为无法安全确认是否已有另一个进程持有会话。若 Pi 版本改变了扩展 API，应先做本机兼容验收。

### Pi Desktop

此入口目前仅支持能校验私有凭据权限的 macOS/Linux。Windows 的访问权限校验尚未实现，因此会明确拒绝接入，不会跳过安全检查；仍可在桌面原窗口使用。

**Pi Agent 与 Pi Desktop 是两个入口，不是把同一任务复制两份。**

- 微信 `/pi`：原生 Pi Agent 会话（可见 CLI 的原 owner 扩展）。
- 微信 `/pi-d`：Pi Desktop 自建的本机桌面任务。不区分大小写，`/PI-D` 也可用；完整指令 `/pi-desktop` 和 `/pi desktop` 继续保留。可带条数，如 `/pi-d 20`。
- 网页终端选择器中选择 **Pi Agent** 或 **Pi Desktop**。发送“任务”仍是跨终端按最近更新时间排序的统一列表。
- Desktop 里显示的 `native-pi:` 原生会话不再重复列进 Desktop 集合；远程 Host 会话也不冒充本机桌面任务。

#### 首次连接

本接入按照 PI-Desktop 0.21.0 的官方桌面控制协议实现。**普通方式打开 Pi Desktop 并不会开启 MCP 接口**；只装了应用就尝试连接，旧版会一直提示接口不可用。这不是模型或公网服务器的问题。

推荐使用官方插件机制接入，**无需退出或重启 Pi Desktop**：

1. 在电脑终端运行 `werelay-pi-desktop-enable`。命令只在 WeRelay 自有目录准备连接插件，不修改 Pi Desktop 配置，不读取会话数据库。首次明确连接 Pi Desktop 时也会自动准备好同一目录。
2. 在 Pi Desktop 的**插件管理**选择“从目录安装”（或“加载开发插件”），选择命令输出的绝对目录，默认是 `~/.werelay/plugins/pi-desktop-connector`。
3. 按桌面提示确认该插件的**桌面控制**权限。WeRelay 不会替用户点击授权或开启免审。插件只开放读取任务、文字消息、新建、改名与停止，不开放删除任务、修改权限或通用命令执行。
4. 再在微信发送 `/pi-d`，或在网页终端菜单选择 Pi Desktop。应能读到原桌面任务；选择任务后继续原上下文，不会另起 Pi CLI。连接插件随 Desktop 正常启动；停用或卸载插件会断开连接。

插件只监听当前电脑回环地址，凭据文件保持仅当前用户可读；不需要复制 token、不开放公网端口。如果 daemon 设置了 `WERELAY_DATA_DIR`，准备命令也要使用同一个目录。更新插件后，在 Pi Desktop 的插件管理中点“重载”，无需重启应用。

已经启用了本机 MCP 的用户无需安装插件，原方式继续支持。若需手动启用 MCP，可先保存工作并正常退出 Pi Desktop，再在终端按实际应用路径启动：

```bash
PI_DESKTOP_MCP_CONTROL=1 /Applications/PI-Desktop.app/Contents/MacOS/PI-Desktop
```

不要在已有主进程还运行时重复执行来期待环境变量生效。使用 `PI-Desktop Local.app` 的用户应替换为自己的实际安装路径。

桌面应用会在其数据目录生成私有 `mcp-control.json`，默认是 `~/.pi-desktop/mcp-control.json`。文件包含本机凭据，**不要复制到聊天、Git 或公网服务器**。不要为排错放宽文件权限。WeRelay 只接受当前用户持有、其他用户不可读、存活进程公布的本机回环 HTTP 接口；不接受公网 URL，不跟随重定向，也不走系统代理。

自定义了 Desktop 数据目录时，在 **WeRelay 启动环境**设置同一个目录（不是 token）：

```bash
WERELAY_PI_DESKTOP_DATA_DIR=/实际桌面数据目录 werelay --adapter pi-desktop
```

已有 daemon 时只在微信发送 `/pi-d`，不要另起同工作区 daemon。没有控制文件时，WeRelay 会显示一次性安装与授权的具体目录，不会回退到 `pi` 或打开替代任务。后台任务枚举保持只读，不会安装插件或触发桌面授权。

#### 本版能力与边界

| 能力 | Pi Desktop 接入 |
| --- | --- |
| 列出本机桌面任务、分页读取文字历史 | 支持；读取与选择不调用桌面打开任务接口 |
| 继续原任务、收到文字完成回复 | 支持协议接入；由原桌面主进程处理，不启动独立 CLI |
| 新建项目任务、重命名、停止 | 支持；仅用户明确操作时调用 |
| 桌面同步 | 使用官方插件 gateway 或 Desktop 自带 MCP 控制接口；原主进程处理消息并刷新界面，不是独立 CLI。MCP 发送／新建可能触发 Desktop 自身的任务选择，不是后台定时切屏 |
| 审批、补充问题 | **仍在桌面处理**；当前 MCP 目录没有完整的待请求读取能力，不自动批准、不修改权限 |
| 图片、队列、模型设置、未发送草稿、远程 Host 任务 | 本入口暂不支持 |
| 超时后的发送 | 不自动重放；保留原任务等待回读。无法确认时先检查桌面，不要连续重发 |
| 断开期间的完成补发 | 当前只监控本进程经 WeRelay 发起的轮次；daemon 重启后的补发不保证 |

接入不能靠模拟服务宣称真机通过。维护者交付时应分别报告协议测试、网页 API 验证、微信真机及桌面同步验收；后两项需在控制接口启用、候选集成后实际确认。

### DeepSeek Harness

桌面用户保持 **DeepSeek Harness**（新版）或 **DSH Desktop**（旧版）运行即可。WeRelay 自动发现桌面 Host 的本机接口；新版端口会动态变化，不要固定填写旧版的 `43120`，也不需要另开 `dsh web`。先在桌面端完成模型配置，然后启动 WeRelay：

```bash
werelay --adapter deepseek
```

只有本来就在使用命令行网页 owner 时才使用下面的方式；它不是桌面端连接失败时的替代修复方式：

```bash
dsh web
werelay --adapter deepseek
```

微信中发送 `/deepseek` 或 `/dsh` 可切换到 Harness；发送“任务”可列出全终端任务。微信输入、审批、补充问题、停止和最终回复都使用所连接 owner 的同一 session，不创建独立会话。

默认只允许连接本机回环地址。若 Harness 使用了不同端口，可在启动 WeRelay 的环境中设置：

```bash
export WERELAY_DEEPSEEK_HARNESS_URL=http://127.0.0.1:3080
```

该地址不能使用公网主机、账号密码、查询参数或 URL 片段。Harness 的 `reasoning` 内容属于内部思考，WeRelay 只把可见正文发送到移动网页和微信。

### OpenCode

公开版 OpenCode 可以使用 npm 安装：

```bash
npm install -g opencode-ai
opencode
```

其他安装方式见官方文档：<https://opencode.ai/docs/>

完成模型和提供方配置后：

```bash
werelay --adapter opencode
```

单 Agent 调试入口：

```bash
werelay-opencode-start
# 或
werelay-bridge-opencode
```

OpenCode 通过本机 HTTP/SSE server 同步 session，不依赖 `node-pty`。

## 四、多 Agent 常驻模式

推荐在项目目录启动一个 daemon。常驻后台优先使用空闲启动，避免登录或服务重启时自动恢复某个终端、弹出桌面应用：

```bash
cd /path/to/project
werelay --idle-start --no-open
```

若明确要在启动时连接某个已有 owner，可使用 `werelay --adapter codex` 或 `werelay --adapter deepseek`。DeepSeek Harness 会复用已经运行的桌面端或显式指定的 `dsh web`，不需要额外打开 companion 终端。

微信中切换：

```text
/codex
/claude
/tclaude
/grok
/codebuddy
/reasonix
/workbuddy
/opencode
```

切换 Agent 后，WeRelay 会显示该 Agent 的任务列表。每个 Agent 维护自己的当前任务；切换不会停止其他 Agent 正在运行的任务。

在 ClawBot 里发送图片时，WeRelay 会先暂存图片，不会立刻给 Agent 下任务。可以连续发送多张图片，再补充任务说明：说明超过 10 个字时自动把全部图片和文字作为一条任务发送；说明不超过 10 个字时会询问是否完整，回复 `1` 发送，回复 `2` 保留图片并重新书写。发送“取消图片”可以放弃本次图片任务。

daemon 绑定启动时的工作目录。要操作另一个项目目录，应停止当前 daemon，再从目标目录启动；不要让同一个微信账号同时被多个 daemon 或 bridge 抢占消息。

## 五、认证、代理与环境变量

WeRelay 启动 Agent 子进程时会继承当前环境，包括 Agent 自己使用的 API 地址、令牌、代理和配置目录。常见变量例如：

```text
ANTHROPIC_BASE_URL
ANTHROPIC_AUTH_TOKEN
OPENAI_API_KEY
HTTP_PROXY
HTTPS_PROXY
NO_PROXY
```

原则：

- 在能够成功直接启动 Agent 的同一终端中启动 WeRelay；
- 不把 Agent 密钥写入仓库、README、截图或 shell 历史；
- 本机回环地址应保留在 `NO_PROXY` 中；
- 使用 systemd/LaunchAgent 时，把必要变量放进权限受限的环境文件。

WeRelay 的完整环境变量见 [运行配置](运行配置.md)。

## 六、安装后的最小验收

1. `werelay-setup` 登录成功；
2. `command -v <agent>` 或 `Get-Command <agent>` 能找到目标 Agent；
3. 直接运行 Agent 可以正常登录和对话；
4. `werelay --adapter <agent>` 启动无错误；
5. 微信发送“任务”能看到该 Agent 的真实任务；
6. 进入任务后发送一句测试文字，桌面端同一任务能看到；
7. Agent 回复、审批和停止状态能回到微信；
8. 如果启用移动网页，再分别验证局域网或公网访问。
