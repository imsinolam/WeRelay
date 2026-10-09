const TASK_SHORT_ADAPTER_CODES: Record<string, string> = {
  codex: "c",
  workbuddy: "w",
  claude: "h",
  tclaude: "t",
  grok: "g",
  codebuddy: "b",
  reasonix: "r",
  pi: "p",
  opencode: "o",
  deepseek: "d",
};
const TASK_SHORT_CODE_ADAPTERS = Object.fromEntries(
  Object.entries(TASK_SHORT_ADAPTER_CODES).map(([adapter, code]) => [code, adapter]),
) as Record<string, string>;
const TASK_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WeRelayTaskShortTarget = {
  adapter: string;
  threadId: string;
};

function encodeTaskShortAdapter(adapter: string): string {
  const normalized = adapter.trim().toLowerCase() || "codex";
  const known = TASK_SHORT_ADAPTER_CODES[normalized];
  if (known) return known;
  return `x${Buffer.from(normalized, "utf8").toString("base64url")}.`;
}

function decodeTaskShortAdapter(
  code: string,
): { adapter: string; payloadOffset: number } | null {
  if (code.startsWith("x")) {
    const separator = code.indexOf(".", 1);
    if (separator < 2) return null;
    try {
      const adapter = Buffer.from(code.slice(1, separator), "base64url")
        .toString("utf8")
        .trim()
        .toLowerCase();
      if (!adapter || adapter.length > 64) return null;
      return { adapter, payloadOffset: separator + 1 };
    } catch {
      return null;
    }
  }
  const adapter = TASK_SHORT_CODE_ADAPTERS[code.slice(0, 1)];
  return adapter ? { adapter, payloadOffset: 1 } : null;
}

function decodeUuidPayload(payload: string): string | null {
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.length !== 16) return null;
    const hex = bytes.toString("hex");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  } catch {
    return null;
  }
}

export function encodeWeRelayTaskShortCode(
  adapter: string | undefined,
  threadId: string,
): string {
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId) throw new Error("任务 ID 不能为空。");
  const adapterPrefix = encodeTaskShortAdapter(adapter ?? "codex");
  if (TASK_UUID_PATTERN.test(normalizedThreadId)) {
    const bytes = Buffer.from(normalizedThreadId.replaceAll("-", ""), "hex");
    return `${adapterPrefix}u${bytes.toString("base64url")}`;
  }
  return `${adapterPrefix}s${Buffer.from(normalizedThreadId, "utf8").toString("base64url")}`;
}

export function decodeWeRelayTaskShortCode(
  code: string,
): WeRelayTaskShortTarget | null {
  const normalized = code.trim();
  if (!normalized || normalized.length > 768) return null;
  const adapterTarget = decodeTaskShortAdapter(normalized);
  if (!adapterTarget) return null;
  const kind = normalized.slice(adapterTarget.payloadOffset, adapterTarget.payloadOffset + 1);
  const payload = normalized.slice(adapterTarget.payloadOffset + 1);
  if (!payload) return null;
  let threadId: string | null = null;
  if (kind === "u") {
    threadId = decodeUuidPayload(payload);
  } else if (kind === "s") {
    try {
      threadId = Buffer.from(payload, "base64url").toString("utf8").trim();
    } catch {
      threadId = null;
    }
  }
  if (!threadId || threadId.length > 512) return null;
  return { adapter: adapterTarget.adapter, threadId };
}
