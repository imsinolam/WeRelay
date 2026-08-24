# 公网 Relay：给用户 Agent 的配置与验收 Runbook

这是一份可以直接交给用户自己的 Agent 执行的操作手册。目标是在一台 Linux 公网服务器上部署 WeRelay Relay，让用户电脑主动连接服务器，并完成从 HTTPS 页面到电脑真实 Agent 任务的端到端验收。

本 Runbook 不使用 cloudflared、ngrok、frp、SSH `-R` 或其他通用端口穿透；公网服务器只中继 WeRelay 的任务级请求。

可以先把下面这段话和本文一起交给 Agent：

> 请严格按本 Runbook 执行。先只做只读预检，列出缺失输入、现有托管方式和执行计划；未经我确认，不要修改 systemd、Nginx、LaunchAgent 或启动脚本。执行时不得输出设备密钥，任何验收失败都必须保留为失败，最终按文末验收表报告。

## 一、Agent 执行规则

执行本 Runbook 的 Agent 必须遵守：

1. **先收集输入，再修改系统。** 缺少域名、SSH、权限或进程托管方式时必须询问用户，不能猜测。
2. **不输出设备密钥。** 设备密钥不能出现在最终回复、截图、URL、Git、issue 或命令行参数中。
3. **先备份再修改。** 修改现有 Nginx、systemd、LaunchAgent 或启动脚本前，记录路径并创建带时间戳的备份。
4. **不开放内部端口。** 服务器公网只开放 `80/443`；Relay 内部端口 `14396` 必须保持回环监听。
5. **不发布本机端口。** 不得把用户电脑的 `4396` 端口通过任何通用隧道暴露到公网。
6. **任何失败都保留为失败。** `/health` 正常不等于端到端可用；必须验证真实任务、消息、审批或停止能力。
7. **不破坏现有托管。** 用户电脑已有 LaunchAgent、systemd 或其他 supervisor 时，应修改现有唯一 owner，不能再创建第二个 watchdog 或重复 daemon。

## 二、开始前向用户确认

Agent 应先得到以下信息：

| 输入 | 示例 | 要求 |
| --- | --- | --- |
| 公网服务器 SSH 目标 | `root@203.0.113.10` | Agent 能通过 SSH 操作，且拥有所需 sudo 权限 |
| Linux 发行版 | Ubuntu 24.04 | 用于确认包管理器和服务路径 |
| Relay 域名 | `relay.example.com` | 已解析到该服务器公网 IP |
| HTTPS 方案 | Nginx + Certbot / 已有证书 / Caddy | 不允许用自签名证书作为正式验收 |
| 用户电脑系统 | macOS / Linux / Windows | 用于选择环境变量持久化方式 |
| WeRelay 项目目录 | `/path/to/project` | daemon 会绑定到该目录 |
| 电脑端托管方式 | 手动终端 / LaunchAgent / systemd | 必须只保留一个 daemon owner |

开始前还要确认：

- 服务器与电脑都能安装 Node.js `>= 24`；
- 电脑已经完成 `werelay-setup`；
- 电脑上的目标 Agent 可以独立启动并读取真实任务；
- 用户同意暂时停止并重启 WeRelay daemon 完成环境变量持久化。

## 三、执行计划概览

Agent 应按以下顺序执行，不要跳步：

1. 服务器预检；
2. 安装 Relay；
3. 创建设备身份与私有环境文件；
4. 配置并启动 systemd；
5. 配置 HTTPS 反向代理；
6. 在用户电脑配置相同设备身份；
7. 启动或重启唯一的 WeRelay daemon；
8. 完成健康、登录、真实任务和离线行为验收；
9. 向用户提交不含密钥的验收报告。

## 四、服务器预检

以下命令在**公网 Linux 服务器**执行：

```bash
uname -a
node --version
npm --version
command -v node
command -v npm
getent ahostsv4 relay.example.com || true
sudo ss -ltnp
```

把 `relay.example.com` 替换为真实域名。

通过条件：

- Node.js 主版本不低于 24；
- 域名解析到当前服务器；
- `80/443` 的现有占用符合用户选择的 HTTPS 方案；
- `14396` 没有被未知公网服务占用。

如果 Node.js 版本不足，Agent 应使用该服务器已经认可的 Node 安装方式升级；不能未经用户同意替换现有生产 Node 环境。

## 五、安装 WeRelay Relay

WeRelay 没有 npm Registry 公共包。发布 Agent 应从已审核的 GitHub 源码生成本地 tarball，记录校验值，再把同一份产物上传到 Relay 服务器。详细的源码构建步骤见 [从 GitHub 安装与更新 WeRelay](GitHub源码安装与更新.md)。

在已审核源码目录生成产物：

```bash
npm ci
PACKAGE_FILE="$(npm pack --silent)"
shasum -a 256 "$PACKAGE_FILE"
scp "$PACKAGE_FILE" relay-host:/tmp/werelay-release.tgz
```

在服务器安装并确认入口：

```bash
sudo npm install -g /tmp/werelay-release.tgz
rm -f /tmp/werelay-release.tgz
RELAY_BIN="$(command -v werelay-relay-server)"
test -n "$RELAY_BIN"
readlink -f "$RELAY_BIN"
npm root -g
npm list -g werelay --depth=0
```

这里的 `npm install -g` 安装的是上传的本地 tarball，不会访问 npm Registry。记录 `RELAY_BIN` 的真实结果。后面的 systemd `ExecStart` 必须使用这个绝对路径，不能假设一定是 `/usr/local/bin/werelay-relay-server`。

Relay 可执行文件和 Node.js 必须位于 `werelay` 服务账号能够访问的稳定系统路径。如果结果位于 `/root/.nvm`、某个普通用户的 `~/.nvm` 或其他受 `ProtectHome=true` 限制的目录，不要直接写入 systemd；应改用服务器认可的系统级 Node.js/npm 安装方式。也不要把 `ExecStart` 固定到某个会随 Node 升级变化的版本目录，否则 npm 已升级而服务仍可能运行旧副本。

## 六、创建设备身份

设备 ID 可以使用不含个人信息的固定名称，例如：

```text
werelay-device
```

设备密钥至少使用 32 字节随机值。推荐由 Agent 在安全环境中生成并直接写入受限文件，不在回复中显示：

```bash
umask 077
openssl rand -hex 32 > /tmp/werelay-device-token
chmod 600 /tmp/werelay-device-token
```

该临时文件只能用于把同一密钥写入服务器和用户电脑的私有配置。跨机器传输时应通过 SSH 标准输入、SCP 或用户已经认可的秘密管理工具完成；不要把密钥拼进命令行参数、URL、聊天消息或 Agent 最终回复。两端配置完成并核对权限后，应删除不再需要的临时副本。设备密钥与移动网页登录密码必须不同。

## 七、配置服务器环境

创建专用服务账号：

```bash
sudo useradd --system --create-home --home-dir /var/lib/werelay --shell /usr/sbin/nologin werelay 2>/dev/null || true
```

创建 `/etc/werelay-relay.env`，内容如下：

```text
WERELAY_RELAY_HOST=127.0.0.1
WERELAY_RELAY_PORT=14396
WERELAY_RELAY_DEVICE_ID=werelay-device
WERELAY_RELAY_DEVICE_TOKEN=替换为刚生成的设备密钥
WERELAY_RELAY_TASK_LINK_STATE_FILE=/var/lib/werelay/relay-task-links.json
```

Agent 写入时不得把设备密钥打印到终端输出。完成后检查权限：

```bash
sudo chown root:root /etc/werelay-relay.env
sudo chmod 600 /etc/werelay-relay.env
sudo stat -c '%U %G %a %n' /etc/werelay-relay.env
```

预期权限：

```text
root root 600 /etc/werelay-relay.env
```

## 八、配置 systemd

安装后的本地 tarball 中包含模板：

```bash
PKG_ROOT="$(npm root -g)/werelay"
sudo cp "$PKG_ROOT/deploy/systemd/werelay-relay.service.example" /etc/systemd/system/werelay-relay.service
sudo editor /etc/systemd/system/werelay-relay.service
```

Agent 必须核对：

- `ExecStart` 是前面 `RELAY_BIN` 记录的绝对路径；
- `User=werelay`、`Group=werelay`；
- `EnvironmentFile=/etc/werelay-relay.env`；
- `StateDirectory=werelay`；
- `StateDirectoryMode=0700`；
- 没有 `--allow-non-loopback`；
- 没有把设备密钥直接写入 unit 文件或 `ExecStart`。

启动前还要确认服务账号能够访问 Relay 入口，并能从 unit 的实际 `PATH` 找到 Node.js。若服务器使用自定义系统路径，应把稳定路径显式写入 unit，而不是依赖交互式 shell 或 NVM 初始化脚本。

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now werelay-relay
sudo systemctl status werelay-relay --no-pager
```

查看日志：

```bash
sudo journalctl -u werelay-relay -n 100 --no-pager
```

服务器本机验收：

```bash
curl -fsS http://127.0.0.1:14396/health
sudo ss -ltnp | grep 14396
```

电脑尚未连接时，允许出现：

```json
{"ok":true,"deviceOnline":false}
```

监听地址必须是 `127.0.0.1:14396` 或 `[::1]:14396`，不能是 `0.0.0.0:14396`。

## 九、配置 HTTPS 入口

GitHub 仓库和安装后的本地 tarball 提供 Nginx 模板：

```bash
PKG_ROOT="$(npm root -g)/werelay"
sudo cp "$PKG_ROOT/deploy/nginx/werelay.conf.example" /etc/nginx/sites-available/werelay.conf
sudo editor /etc/nginx/sites-available/werelay.conf
```

替换：

- `relay.example.com`；
- HTTPS 证书路径；
- 发行版对应的 Nginx 启用方式。

必须保持：

```text
proxy_pass http://127.0.0.1:14396
proxy_read_timeout 120s
proxy_send_timeout 120s
```

安全要求：

- 公网防火墙只开放 `80/443`；
- 不开放 `14396`；
- 由 Nginx/Caddy 终止 TLS；
- 不记录包含 setup 参数或任务选择器的完整查询串；
- 上传上限应覆盖移动端附件大小。

检查：

```bash
sudo nginx -t
sudo systemctl reload nginx
curl -fsS https://relay.example.com/health
```

公网健康检查在电脑尚未连接时仍可返回 `deviceOnline:false`，但 TLS 必须有效，不能忽略证书错误完成验收。

## 十、让用户电脑主动连接 Relay

以下步骤在**用户电脑**执行。

先记录电脑端版本，并与服务器端安装结果一起写入验收报告：

```bash
npm list -g werelay --depth=0
```

服务器与电脑应使用同一兼容版本；如果版本不同，先说明差异并完成兼容性判断，不要直接假定协议兼容。

三个变量必须与服务器一致：

```bash
export WERELAY_RELAY_URL=https://relay.example.com
export WERELAY_RELAY_DEVICE_ID=werelay-device
export WERELAY_RELAY_DEVICE_TOKEN='与服务器相同的设备密钥'
```

临时验证可以在当前 shell 中设置。正式长期运行时，必须把变量写入唯一 daemon owner 的受限环境：

- macOS LaunchAgent：写入现有 plist 的 `EnvironmentVariables`，不要新建第二个重复 daemon；
- Linux systemd：写入权限为 `0600` 的 `EnvironmentFile`；
- 手动终端：写入用户自己的私有 shell 配置或启动脚本，并避免把密钥提交到仓库。

`.env.example` 不会被 WeRelay 自动加载。

如果修改的是 macOS LaunchAgent，Agent 应：

1. 记录现有 plist 路径、label、ProgramArguments、WorkingDirectory、PATH 和当前进程命令；
2. 创建备份；
3. 保留已有环境变量，只增加或更新三个 `WERELAY_RELAY_*` 变量；
4. 先 `bootout` 唯一服务；
5. 修改完成后 `bootstrap`；
6. 确认 plist 的入口与当前全局安装的 `werelay` 一致，避免升级后仍运行旧版本目录；
7. 确认 `launchctl print gui/$(id -u)/<label>` 为运行状态，并从进程列表确认该工作目录只有一个 daemon owner；`runs` 是累计启动次数，不能用 `runs=1` 判断单实例；
8. 不恢复基于公网 `deviceOnline` 强制重启 daemon 的第二 watchdog。

启动示例：

```bash
cd /path/to/your/project
werelay --idle-start --no-open
```

本机网页验收：

```bash
curl -fsS http://127.0.0.1:4396/health
```

如果端口冲突递增，以 `~/.werelay/bridge.log` 中的 `codex_mobile_started` 为准。

## 十一、连接验收

### 1. 公网设备在线

在任意可访问公网域名的机器执行：

```bash
curl -fsS https://relay.example.com/health
```

必须包含：

```json
{"ok":true,"deviceOnline":true}
```

同时在用户电脑检查：

```bash
grep 'relay_client_started' ~/.werelay/bridge.log | tail -1
```

### 2. 浏览器登录

使用手机移动网络或另一条外部网络打开：

```text
https://relay.example.com
```

通过条件：

- HTTPS 证书有效；
- 能显示登录页；
- 首次设置密码必须从 ClawBot 的任务链接进入；
- 登录后能看到真实 Agent 和任务列表；
- 页面没有要求用户理解设备密钥。

### 3. 真实任务端到端消息

1. 在电脑 Agent 中打开一个可识别的真实任务；
2. 在公网网页进入同一个任务；
3. 从网页发送唯一文本，例如 `relay-e2e-20260818-120000`；
4. 确认电脑端同一任务实时出现该文本；
5. 等待 Agent 回复；
6. 确认网页和 ClawBot 收到同一个任务的结果。

如果网页消息进入了另一个隐藏任务，验收失败。

### 4. 操作能力

在不影响真实工作的测试任务中验证可用项：

- 审批定位到具体请求并可处理；
- 停止操作只停止当前任务；
- 排队消息可编辑或删除；
- 附件能到达同一桌面任务；
- 任务切换后网页标题和内容跟随真实任务。

某个 Agent 明确不支持的能力，应记录为产品边界，不能伪造成功结果。

### 5. 离线行为

暂时停止用户电脑上的 WeRelay daemon，但不要关闭 Relay 服务器：

1. 公网 `/health` 应变成 `deviceOnline:false`；
2. 公网页面应明确显示电脑离线；
3. 页面不能新建独立 CLI/ACP 会话代替桌面任务；
4. 恢复唯一 daemon 后，`deviceOnline` 应重新变为 `true`。

完成后必须恢复用户原来的托管状态。

## 十二、最终验收表

Agent 最终应提交如下报告，且不得包含设备密钥、Cookie、setup URL 或任务正文：

| 检查项 | 结果 | 证据摘要 |
| --- | --- | --- |
| 服务器与电脑版本 | 通过/失败 | 两端 `werelay` 版本，不含安装路径中的用户名 |
| 服务器 Relay 仅回环监听 | 通过/失败 | `127.0.0.1:14396` |
| HTTPS 有效 | 通过/失败 | 域名与证书状态 |
| 公网健康检查 | 通过/失败 | `ok`、`deviceOnline` |
| 用户电脑本地健康 | 通过/失败 | 实际本地端口 |
| daemon 唯一 owner | 通过/失败 | supervisor、PID、实际命令与安装版本 |
| 真实任务列表 | 通过/失败 | Agent 数与任务数，不写任务名 |
| 网页消息进入同一桌面任务 | 通过/失败 | 测试消息时间与任务一致性 |
| 回复、审批、停止或附件 | 通过/失败/不适用 | 已验证能力 |
| 电脑离线表现 | 通过/失败 | 是否明确离线且不创建替代会话 |
| 回滚与备份 | 已准备/未准备 | 备份路径，不含秘密 |

任何一项失败都应写明阻塞原因和恢复动作，不能只回复“部署完成”。

## 十三、回滚

### 服务器

```bash
sudo systemctl disable --now werelay-relay
```

然后恢复备份的 Nginx 配置并执行：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

除非用户明确要求，不删除 `/var/lib/werelay`、设备状态或环境文件；保留它们便于恢复和审计。

### 用户电脑

- 从唯一 daemon owner 中移除三个 `WERELAY_RELAY_*` 变量；
- 恢复修改前的 LaunchAgent、systemd 或启动脚本；
- 重启 daemon；
- 确认局域网网页和 ClawBot 仍可使用。

## 十四、升级

服务器和电脑应安装从同一 GitHub 提交生成的 tarball，并分别重启。重复[第五节](#五安装-werelay-relay)的构建、校验、上传和安装步骤，不要从 npm Registry 安装。

升级后重新完成：

1. 服务器本机 `/health`；
2. 公网 `/health` 与 `deviceOnline:true`；
3. 真实任务列表；
4. 一次端到端消息；
5. 一次离线恢复检查。

原理、安全边界和常见故障见 [局域网与公网访问](../架构设计/局域网与公网访问.md)。
