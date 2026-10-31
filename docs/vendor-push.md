# 系统推送接入（vivo 先行，预留多厂商）

本文说明 WeRelay Android App 如何接入厂商系统推送，以及当前能做什么、还不能做什么。

## 为什么要分厂商

中国大陆的 Android 没有统一系统推送通道。App 被杀掉后仍要收到通知，只能走各厂商的系统通道：

| 厂商 | 通道 | 覆盖机型 |
|---|---|---|
| vivo | vivo Push（vpush） | vivo / iQOO |
| 小米 | MiPush | 小米 / 红米 |
| OPPO / 一加 | ColorOS Push | OPPO 系 |
| 荣耀 | Honor Push | 荣耀 |
| 华为 | HMS Push | 华为 |

第三方聚合推送（极光、个推等）本质仍是替你在各家后台配置，不改变这个事实。**当前只实现了 vivo。**

## 分工

两端都要改，缺一不可：

- **App 端**：集成 vivo SDK → 拿到 regid → 上报服务端。
- **服务端**：用 AppID/AppKey/AppSecret 鉴权 → 按 regid 发单推。

## App 端

已在 `DeskRelay-App` 完成：

| 文件 | 作用 |
|---|---|
| `android/app/src/main/java/app/werelay/mobile/PushRegistrar.java` | 初始化 SDK、`turnOnPush`、取 regid 并上报 |
| `android/app/src/main/java/app/werelay/mobile/WeRelayPushReceiver.java` | 接收 SDK 回调（含 regid 轮换） |
| `android/app/build.gradle` | Maven 依赖 `vivo:vpush`、从本地配置注入占位符 |
| `android/build.gradle` | 加入 vivo 官方 Maven 仓 |

凭据不进仓库。复制模板后填写：

```sh
cp android/sdk-push.properties.example android/sdk-push.properties
```

```properties
VIVO_PUSH_APP_ID=你的AppID
VIVO_PUSH_API_KEY=你的AppKey
```

`sdk-push.properties` 已在 `.gitignore` 中。**缺失时 App 仍能正常构建运行**，只是不注册推送。

安全默认值：

- 只在 `MANUFACTURER == vivo` 且 `PushClient.isSupport()` 为真时初始化；
- 上报请求失败只写日志，不阻塞启动；
- regid 只发给用户自己配置的 WeRelay 服务地址。

## 服务端

| 文件 | 作用 |
|---|---|
| `src/daemon/vendor-push.ts` | 厂商抽象、vivo 鉴权与单推、多厂商分发 |
| `src/daemon/push-registration-store.ts` | regid 存储（按服务器 origin 隔离） |

环境变量（都不设就完全禁用推送，不影响现有功能）：

```sh
WERELAY_VIVO_PUSH_APP_ID=你的AppID
WERELAY_VIVO_PUSH_APP_KEY=你的AppKey
WERELAY_VIVO_PUSH_APP_SECRET=你的AppSecret
WERELAY_PUBLIC_BASE_URL=https://你的域名
```

`WERELAY_PUBLIC_BASE_URL` 必须和 App 里填的服务地址一致，否则查不到该设备的 regid。

接口：

- `POST /api/push/registration` — App 上报 regid（需登录）。
- `DELETE /api/push/registration` — 退出登录或换服务器时清理该 origin 的 regid。

## 消息分类（重要）

按你的选择，当前**只走运营消息**，`category=CONTENT`。

这意味着（官方文档明确写着）：

- 用户端接收和服务器发送都限制在 **7:00–23:00**，时间外发送返回错误码 `10071` 且**不会补发**；
- 受运营消息频控和去重限制；
- 不需要申请消息模板。

如果以后要夜间也能提醒，需要改用**系统消息**的「日程待办」(`TODO`) 分类——vivo 文档把「审批处理、工单处理」列在该场景下，但必须走模板申请审核。**不要在没有模板的情况下把运营消息标成系统消息**，官方会判定违规并处罚。

## 当前能力边界

- 已实现：vivo 单推、regid 上报/失效清理、按 origin 隔离、任务完成与等待审批触发。
- **未验证**：没有真实 AppID/AppSecret，vivo 服务器往返未联调；真机未收过推送。
- 运营消息在 23:00 后不送达；App 被「强行停止」后仍不可靠。
- 现有前台轮询通知（`NotificationService`）保留，作为非 vivo 机型和未配置推送时的路径。
- 两台通道可能对同一事件各提醒一次；尚未做跨通道去重。

## 后续接新厂商

只加一个 provider，不改任务流程：

```ts
createPushDispatch({
  providers: [
    createVivoPushProvider({ credentials: readVivoCredentials() }),
    createXiaomiPushProvider({ ... }),
  ],
});
```

需要同时放宽的位置：`PushProviderId`、`/api/push/registration` 的 provider 校验、App 端对应 SDK 与上报。
