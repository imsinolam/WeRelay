/** Turn untrusted provider errors into actionable text without exposing credentials or URLs. */
export function formatPiModelError(error: string | undefined): string {
  const detail = error?.trim() ?? "";
  if (/(?:connection error|fetch failed|ECONN|ENETUNREACH|EHOSTUNREACH|network error)/i.test(detail)) {
    return "Pi 模型连接失败。请检查当前模型服务或网络后重试。";
  }
  if (/(?:\b429\b|rate limit|too many requests)/i.test(detail)) {
    return "Pi 模型服务请求过多。请稍后重试或在 Pi 窗口选择其他可用模型。";
  }
  if (/(?:\b401\b|\b403\b|unauthorized|authentication failed|invalid api key)/i.test(detail)) {
    return "Pi 模型鉴权失败。请在 Pi 窗口检查当前模型的登录或密钥配置。";
  }
  return "Pi 模型请求失败。请在 Pi 窗口查看具体错误并检查当前模型配置。";
}
