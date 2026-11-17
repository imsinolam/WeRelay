# DSH DeepSeek与Harness经验

> 来源：`AGENTS.md` 原文 `## Agent Experience Records`（main `baa4823acfe6a6ddeadae9bc3459dd723bf4d31e`）。按主题归类，每条均保留原文全文，并在行首标明源文件原始行号；迁移不删除任何一条经验。交叉主题按最接近的一条归档，根规则链接入口统一指向本文。

<!-- AGENTS.md:268 -->
- **DeepSeek Harness 网页 Host 的 `/api/events.mux` 必须按 WebSocket 下行连接，不能当作普通 HTTP SSE 读取。** 真实 `dsh web` 对 HTTP 请求会返回 426，导致消息仍可由历史轮询恢复但审批永远收不到；使用 `ws://127.0.0.1:<port>/api/events.mux` 并保留历史补偿，才能同时覆盖实时审批和断线完成恢复。
<!-- AGENTS.md:287 -->
- **DeepSeek Harness 的失败原因要从 `turn/end.reason.error` 等嵌套字段提取，新建空白任务首次发送图片时要选用可用的视觉模型。** DSH 会在文本模型收到图片时直接拒绝 prompt，也会把 OpenRouter 空响应写进嵌套错误；若只读顶层 `reason.message` 或继续使用文本模型，用户只能看到笼统失败，既无法判断是图片能力还是模型服务异常，也无法正确重试。
<!-- AGENTS.md:289 -->
- **DeepSeek Harness 模型菜单必须展开 `session.models.groups` 的全部 provider，不能只显示当前会话的 provider。** 同一个 DSH 安装可同时加载 DeepSeek、Tencent、OpenRouter、OX Alpha 等来源，而不同 provider 还可能复用相同 model id；用 `provider::model` 作为内部选择键、用“来源 · 模型名”展示并兼容旧裸 model id，才能让每个会话都看到完整可选模型并精确切换。
