# 从 GitHub 安装与更新 WeRelay

WeRelay 当前只在 GitHub 公开源码，**没有发布到 npm Registry**。GitHub 开源和 npm 公共包是两件独立的事：项目可以只维护 GitHub 仓库，不必把同名包上传到 npm。

仓库仍保留 `package.json`、`npm run` 和 `npm pack`，因为 WeRelay 是 Node.js 命令行项目，需要这些工具来安装依赖、构建代码并生成可安装的本地压缩包。这里的 npm 只是本机构建与安装工具，不是公开下载渠道。

## 首次安装

需要 Node.js `>= 24`、Git，以及至少一个已经安装并登录的受支持 Agent。

macOS / Linux：

```bash
git clone https://github.com/imsinolam/WeRelay.git
cd WeRelay
npm ci
PACKAGE_FILE="$(npm pack --silent)"
npm install -g "./$PACKAGE_FILE"
werelay-setup
```

Windows PowerShell：

```powershell
git clone https://github.com/imsinolam/WeRelay.git
Set-Location WeRelay
npm ci
$packageFile = npm pack --silent
npm install -g ".\$packageFile"
werelay-setup
```

`npm pack` 会先完成类型检查和正式构建，再生成类似 `werelay-0.3.4.tgz` 的本地安装包。`npm install -g` 安装的是这个文件，不会从 npm Registry 下载 WeRelay。

安装后检查：

```bash
command -v werelay
command -v werelay-setup
werelay-check-update
```

Windows PowerShell 使用 `Get-Command werelay` 和 `Get-Command werelay-setup`。

## 在微信中更新

安装了新版更新能力的 WeRelay，会在启动后及运行期间**每 24 小时检查一次** GitHub 已发布的 Release。新版本统一使用 `0.x.x`，末位逐次增加；同一版本对应同一源码和安装包，不再分 preview 与正式版。更新检查仍兼容历史预发布记录，并按完整版本号判断，不会自动降级。电脑关机或休眠错过检查时，下次运行会补查；自动提醒每 24 小时最多成功发送一次，同一版本不重复提醒。网络失败会稍后重试，微信上下文失效时等你发来新消息再尝试送达。

- 发送 **“检查更新”**：只查询和显示结果，不安装；手动查询不受自动检查周期限制。
- 收到提醒后回复 **“更新”** 或 **`/update`**：自动下载对应 Release 的源码归档，在独立临时目录中安装锁定依赖、构建并生成 tarball，再安装这个本地 tarball。历史预发布记录仍保留原标注。
- 安装前保留原包和命令入口备份；替换或版本校验失败时自动回退。若回退也失败，会明确告知，不声称旧安装仍完好。
- 安装后**不会自行重启**。可回复 **“重启”**：仅在能确认由已知 macOS launchd 服务托管时退出并由服务恢复；手动启动、Windows 或其他未确认保活的环境会提示在电脑重启。重启期间微信和网页连接会短暂断开。
- 更新检查、下载和构建在后台进行，不阻塞正常微信任务消息。替换安装仍可能影响随后启动的 WeRelay 入口，请避开关键操作时段；不要把“后台更新”理解为绝无中断风险。

只允许更新**当前正在运行的独立全局安装**。从源码直接启动或使用软链接的开发环境不会被自动覆盖，不会猜测另一份全局安装代替操作。只接受本仓库真正发布的 Release；草稿、只有 tag 的版本和 `main` 分支代码不会触发自动更新。

旧版本若尚不具备微信更新指令，需先按下面的手动方法安装一次。此功能只更新该电脑的 WeRelay，不会顺便部署公网 Relay 或替维护者推送 GitHub。

## 手动更新

从 [GitHub Releases](https://github.com/imsinolam/WeRelay/releases) 选择要安装的版本，下载该 Release 的 Source code 并解压。进入该版本目录后重新安装依赖并打包：

macOS / Linux：

```bash
cd /path/to/WeRelay
npm ci
PACKAGE_FILE="$(npm pack --silent)"
npm install -g "./$PACKAGE_FILE"
```

Windows PowerShell：

```powershell
Set-Location C:\path\to\WeRelay
npm ci
$packageFile = npm pack --silent
npm install -g ".\$packageFile"
```

如果 WeRelay 由 LaunchAgent、systemd 或其他后台服务运行，更新前先停止服务，安装完成后再恢复并验活，避免构建期间运行中的入口被替换。

## 服务器安装

部署公网 Relay 时，也应从同一份已审核源码生成 tarball，再把这个 tarball 上传到服务器安装。不要在服务器执行 `npm install -g werelay@latest`，因为 npm Registry 上没有这个公共包。

示例：

```bash
# 已审核源码目录
npm ci
PACKAGE_FILE="$(npm pack --silent)"
scp "$PACKAGE_FILE" relay-host:/tmp/

# Relay 服务器
sudo npm install -g "/tmp/$PACKAGE_FILE"
rm -f "/tmp/$PACKAGE_FILE"
```

正式发布流程应记录 tarball 文件名和校验值，并保证本机与服务器安装的是同一份产物。

## 为什么保留 npm 格式

- `npm run ...`：执行 lint、测试、构建和安全检查脚本；
- `npm pack`：生成独立、可审查、可重复安装的 `.tgz` 文件；
- `npm install -g <本地 .tgz>`：把 WeRelay CLI 安装到全局命令目录；
- `package-lock.json`：锁定依赖版本，支持可重复构建。

这些用途不要求项目存在 npm 公共包。仓库已设置为私有包元数据，防止误执行 `npm publish`。
