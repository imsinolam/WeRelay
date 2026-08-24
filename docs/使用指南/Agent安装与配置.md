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
```

Windows PowerShell：

```powershell
Get-Command codex
Get-Command claude
Get-Command opencode
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
| WorkBuddy Desktop | `/Applications/WorkBuddy.app` | macOS 安装应用并至少创建一个任务 | `werelay --adapter workbuddy` |
| DeepSeek Harness | `dsh web` | 配置模型后保持 Harness 网页进程运行 | `werelay --adapter deepseek` |
| OpenCode | `opencode` | 安装后运行 `opencode` 完成模型配置 | `werelay --adapter opencode` |

TClaude、Grok CLI、CodeBuddy、reasonix、WorkBuddy 和 DeepSeek Harness 可能来自组织内部或供应商渠道。WeRelay 不提供这些工具的安装包，也不应在公开文档中猜测其安装命令；请使用工具自身的官方或组织内说明。

“可以列出任务”不自动等于“电脑端实时同步”。Codex 与 WorkBuddy 使用桌面原生 owner；DeepSeek Harness 复用当前 `dsh web` owner；Claude Code、TClaude 使用 WeRelay 连接的可见 CLI owner；OpenCode、Grok、CodeBuddy 与 reasonix 使用电脑界面和远程入口共用的共享服务 owner。完整边界见 [README 的会话一致性矩阵](../../README.md#支持的-agent-与会话一致性)。

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

### DeepSeek Harness

WeRelay 直接连接已经运行的 `dsh web`，不会再启动一条独立的 headless Harness 会话。先在 Harness 中完成 API 和默认模型配置，再保持网页进程运行：

```bash
dsh web
werelay --adapter deepseek
```

微信中发送 `/deepseek` 或 `/dsh` 可切换到 Harness；发送“任务”可列出现有 Harness session。微信输入、审批、补充问题、停止和最终回复都会进入同一个 session，并同步显示在 Harness 网页中。

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

若明确要在启动时连接某个已有 owner，可使用 `werelay --adapter codex` 或 `werelay --adapter deepseek`。DeepSeek Harness 会复用已经运行的 `dsh web`，不需要额外打开 companion 终端。

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
