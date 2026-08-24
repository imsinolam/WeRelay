# WeRelay

<p align="center"><strong>One real session. Every screen.</strong></p>

<p align="center">
  <a href="https://github.com/imsinolam/WeRelay"><img alt="GitHub stars" src="https://img.shields.io/github/stars/imsinolam/WeRelay?label=Stars&amp;style=for-the-badge&amp;logo=github&amp;color=0891b2&amp;labelColor=1c1917"></a>
  <img alt="License" src="https://img.shields.io/badge/License-AGPL--3.0-7c3aed?style=for-the-badge&labelColor=1c1917">
</p>

<p align="center"><img src="docs/images/werelay-logo.svg" width="72%" alt="WeRelay"></p>

WeRelay 把电脑上的 AI 编程任务延伸到微信 ClawBot、局域网网页和可选的公网网页。对于已经具备“原任务接入”能力的 Agent，远程消息、审批、停止操作和回复都会进入电脑端原来的任务，不会另开隐藏会话。

**电脑 Agent 始终是任务 owner，WeRelay 和远程界面只是入口；但不同 Agent 当前达到的会话一致性级别并不相同，不能把“命令能接入”都写成“桌面端实时同步”。**

<p align="center"><img src="docs/images/werelay-four-panel-white-paper-boy-v10-handoff-comic.png" width="100%" alt="WeRelay 在电脑开工、手机接力、任务完成后再回到电脑继续工作"></p>

## 它们是什么关系

<p align="center"><img src="docs/images/werelay-relationship-simple.svg" width="100%" alt="手机通过微信、局域网网页或公网网页进入 WeRelay，继续电脑 Agent 中的真实任务；任务在电脑，手机只是入口"></p>

| 组成部分 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| 电脑 Agent | 持有真实任务、上下文、项目文件、模型和工具权限 | 不需要把任务复制到手机 |
| WeRelay | 映射真实任务，在各入口间同步消息、状态、审批和附件 | 不成为第二个 Agent，不创建替代会话 |
| 微信 ClawBot | 随时查看任务、发消息、审批、停止并接收完成通知 | 不保存另一份任务历史 |
| 局域网网页 | 手机与电脑同网时直接访问电脑上的 WeRelay | 不能跨互联网直接访问本机 |
| 公网网页 | 通过自建 Relay 在外网访问同一任务 | Relay 不运行 Agent，也不开放本机通用端口 |

三个远程入口共享同一个 WeRelay Runtime，因此不会彼此产生三份历史。至于 Runtime 与电脑 Agent 是否已经做到“同一条任务、电脑端实时可见”，取决于具体适配器，见下方能力矩阵。电脑离线或 Agent 不可用时，远程端必须明确显示不可用，不能静默创建替代会话。

## 快速开始

需要 Node.js `>= 24`、Git，并已安装、登录至少一个支持的 Agent。WeRelay 当前只通过 GitHub 公开源码，没有发布到 npm Registry。仓库使用 npm 完成本地构建和 tarball 安装，但 npm 不是公开下载渠道。

```bash
git clone https://github.com/imsinolam/WeRelay.git
cd WeRelay
npm ci
PACKAGE_FILE="$(npm pack --silent)"
npm install -g "./$PACKAGE_FILE"
werelay-setup
cd /path/to/your/project
werelay --adapter codex
# 常驻后台、不自动恢复终端或打开桌面应用：werelay --idle-start --no-open
```

Windows PowerShell、更新和服务器安装步骤见 [从 GitHub 安装与更新 WeRelay](docs/使用指南/GitHub源码安装与更新.md)。

完成微信扫码后，向 ClawBot 发送“任务”即可选择电脑上的真实任务。即使没有公网服务器，daemon 也会自动启动局域网移动网页；第一次使用请先进入一个任务，再发送“状态”，从 ClawBot 返回的授权链接进入并设置移动访问密码。终端打印的基础地址不用于首次设置密码。

后台启动和自动恢复不会自行打开 ChatGPT 或 WorkBuddy；用户在网页或 ClawBot 中明确选择桌面终端或任务时，仍可按需打开对应应用。只有需要在 daemon 启动阶段自动打开桌面应用时，才传入 `--open-desktop-apps`。完整步骤见 [5 分钟启用局域网移动网页](docs/使用指南/局域网移动网页快速开始.md)。

不要把扫码结果、setup 链接、移动密码、`~/.werelay` 或任务截图提交到 issue。

详细的 Agent 前置安装、PATH 检查和单 Agent 调试命令见 [Agent 安装与配置](docs/使用指南/Agent安装与配置.md)。

## 支持的 Agent 与会话一致性

这里的“支持”不能只表示命令能够启动，需要分清三个能力：

- **继续原任务**：选择已有任务后，手机消息进入同一个任务 ID 和上下文；
- **电脑端可见**：手机消息和 Agent 回复能在对应的电脑界面或可见终端中看到；
- **实时同步**：电脑端已经打开该任务时，无须重新加载就能看到远程变化。

| Agent | 继续原任务 | 电脑端可见 | 当前边界 |
| --- | --- | --- | --- |
| Codex Desktop | 是 | 是，原 Codex 任务实时同步 | 完整桌面端接入 |
| WorkBuddy Desktop | 是 | 是，原 WorkBuddy 任务实时同步 | 完整桌面端接入 |
| Claude Code / TClaude | 是，同一 CLI 会话 | 是，在 WeRelay 连接的可见终端中 | 不会自动接管任意一个已经独立打开的终端窗口 |
| OpenCode | 是，同一 OpenCode session | 是，在 WeRelay 连接的 OpenCode 客户端中 | 通过本机 server + attach 共享会话 |
| Grok CLI | 是，同一个 Grok leader 会话 | 是，WeRelay 打开的 Grok 终端实时同步 | 电脑 TUI 和远程入口连接同一个共享 leader |
| CodeBuddy | 是，同一 CodeBuddy `--serve` 任务 | 是，WeRelay 打开的 CodeBuddy 界面实时同步 | 可见界面与 HTTP ACP 共用一个 `--serve` owner，不启动独立 `--acp` |
| reasonix | 是，直接恢复原 transcript | 是，官方 reasonix Web UI 与远程入口实时同步 | 使用 `serve -resume` 打开原文件，不复制或转换历史 |
| DeepSeek Harness | 是，同一 Harness session | 是，当前 `dsh web` 页面实时同步 | 连接本机 Harness Host API，不启动第二个 headless Harness；内部 reasoning 不发送到网页或微信 |

Shell 只是可选的命令执行适配器，不是有任务历史的 Agent，因此不列入会话支持范围。

WeRelay 的目标是让所有正式 Agent 最终都满足“继续原任务、电脑可见、手机与电脑不分叉”。在达到这个标准前，文档必须明确标注限制，不能只写成笼统的“支持”。WeRelay 也不分发这些 Agent，不代替它们完成账号、模型或供应商配置。

## 没有服务器与有服务器

| 模式 | 微信 ClawBot | 移动网页 | 连接方向 |
| --- | --- | --- | --- |
| 没有公网服务器 | 可在外网使用 | 仅同一局域网可访问 | Mac 主动连接微信服务；网页直接连接 Mac |
| 有公网服务器 | 使用方式不变 | 可通过 HTTPS 公网访问 | Mac 主动连接 Relay；服务器不反向连接 Mac |

公网模式是**应用层任务中继**：只传输 WeRelay 所需的消息、状态、审批和附件，不提供任意 TCP/HTTP 转发，也不把本机监听端口直接发布到公网。

没有服务器时按 [局域网移动网页快速开始](docs/使用指南/局域网移动网页快速开始.md) 操作；需要公网网页时，可把 [公网 Relay Agent 配置与验收](docs/使用指南/公网Relay配置与验收.md) 直接交给用户的 Agent 执行。原理与安全边界见 [局域网与公网访问](docs/架构设计/局域网与公网访问.md)。

## 从 DeskRelay 迁移到 WeRelay

WeRelay 是一次完整品牌迁移：本地安装包标识改为 `werelay`，公开命令改为 `werelay-*`，活动数据目录改为 `~/.werelay`，环境变量改为 `WERELAY_*`。

旧的 `deskrelay-*` 命令和 `DESKRELAY_*` 环境变量不再作为公开兼容入口。首次启动时，WeRelay 会优先从 `~/.deskrelay` 复制缺失的登录、任务和附件状态，再从更早的 `~/.cli-bridge` 补齐；旧目录不会被删除或继续写入。完整迁移说明见 [运行配置](docs/使用指南/运行配置.md#from-deskrelay-to-werelay)。

## 文档

- [完整文档导航](docs/README.md)
- [多 Agent 协作规范](docs/开发协作/多Agent协作规范.md)
- [项目定位](docs/使用指南/项目介绍.md)
- [Agent 安装与配置](docs/使用指南/Agent安装与配置.md)
- [架构与数据流](docs/架构设计/架构与数据流.md)
- [运行配置与品牌迁移](docs/使用指南/运行配置.md)
- [局域网移动网页快速开始](docs/使用指南/局域网移动网页快速开始.md)
- [局域网与公网访问](docs/架构设计/局域网与公网访问.md)
- [公网 Relay Agent 配置与验收](docs/使用指南/公网Relay配置与验收.md)
- [问题排查](docs/使用指南/问题排查.md)
- [开发与测试](docs/开发协作/开发与测试.md)
- [安全说明](SECURITY.md)
- [对外发布](docs/发布/对外发布操作手册.md)

## 安全边界

- 不要公开 `~/.werelay`、登录凭据、设备密钥、移动访问链接、日志或附件；
- 不要使用通用公网隧道把本机端口直接暴露到互联网；
- 公网 Relay 必须使用 HTTPS、长随机设备密钥、访问认证、请求去重和过期控制；
- 当前私有开发仓库可能含历史隐私，公开前必须从审计后的文件快照创建干净 Git 历史。

## License

[AGPL-3.0-or-later](LICENSE.txt)
