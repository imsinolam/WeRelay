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

## 更新

进入原来的源码目录，快进到 GitHub 最新 `main`，重新安装依赖并生成新的本地安装包：

macOS / Linux：

```bash
cd /path/to/WeRelay
git pull --ff-only
npm ci
PACKAGE_FILE="$(npm pack --silent)"
npm install -g "./$PACKAGE_FILE"
```

Windows PowerShell：

```powershell
Set-Location C:\path\to\WeRelay
git pull --ff-only
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
