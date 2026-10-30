# Android App：同一任务台，两种运行方式

Android App 不维护第二份任务台。网页仍使用 `codex-mobile-web.ts` 和会话整理页；`scripts/export-mobile-app.mjs` 从同一份导出 HTML/CSS/JS，App 仓库只维护原生壳和平台桥接。

## 本地构建

要求 Node.js 24、独立 Android 壳仓库、Java 21、Android SDK 35。

在 App 仓库中指定包含本次改动的 WeRelay 源码目录：

```bash
export WERELAY_SOURCE=/path/to/WeRelay
npm ci
npm run sync
cd android
./gradlew assembleDebug testDebugUnitTest
```

`www/` 是生成产物，不能手工维护或提交为第二套前端。任务台更新只修改本仓库，然后重新导出。首次安装内置本地资源；API 通过原生网络层连接用户填写的地址，使用现有访问密码验证，不新增账号。

## 缓存与局部刷新

复用任务台已有的可信本地快照、消息连续性合并、revision 检查、草稿及滚动恢复。App 不再用网页版本检测触发整页跳转；启动先恢复可用缓存，随后验证服务端状态。401 仍要求重新验证。切换服务器主动清除原服务器缓存与会话，避免数据串用。离线缓存不是可执行审批授权。

## 共享版本与签名资源更新

网页与 App 资源版本来自 `mobile-asset-version.ts`，包含任务台、关于页、整理页的内容。前端桥接随 App 资源包一起签名。正式更新包必须由离线保管的 P-256 私钥签名；APK 内置对应公钥。服务端不持有签名私钥。

```bash
node scripts/export-mobile-app.mjs \
  --out /path/to/generated-assets \
  --platform /path/to/App/web/native-platform.js \
  --sign-key /private/path/update-signing-key.pem \
  --sequence 1
```

后续每次发布必须递增 `--sequence`。资源包位于输出目录的 `app-bundle.json`。经过原有发布授权及门禁后，将其放到部署目录并配置：

```bash
WERELAY_MOBILE_APP_BUNDLE=/private/deployment/app-bundle.json
```

本地 Web 服务和公网 Relay 的 `/app-bundle` 读取该文件。未配置返回 404，不自动生成签名或下载不受信任代码。资源包含公开前端代码，不含密码、任务记录或服务器密钥。

App 校验签名、文件摘要、路径、体积、壳兼容版本与单调序列号后，仅暂存更新；下次冷启动启用。启动未确认则回退。旧序列号不能通过重放再次安装。原生权限/插件变更仍需升级 APK。下载或发布文件应原子替换，避免部分写入。

## 后台通知边界

用户主动启用 Android 前台服务后常驻一条通知；不使用厂商推送、不在通知栏直接审批。vivo 需要用户允许后台运行。强行停止、系统限制、网络断开或电脑离线均可能导致延迟；不得承诺一直在线或固定送达时间。真机锁屏、折叠/展开、断网恢复必须另行验收，不能以浏览器或 JVM 单测代替。

## 开发与发布隔离

本次开发不重启现有 daemon、不更新公网 Relay、不推送、不发布 npm。共享源提交与 App 提交应由发布负责人一起验收；只有部署签名资源更新出口后，已安装 App 才能同步获取后续任务台更新。
