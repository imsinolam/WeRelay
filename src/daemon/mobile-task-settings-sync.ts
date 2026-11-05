import type { BridgeSessionModelState } from "../bridge/bridge-types.ts";
import type { MobileNewTaskSettings } from "./mobile-new-task-settings.ts";

/**
 * 任务设置（模型、推理强度）同步辅助。
 *
 * - 选择随消息走：网页只在本地记录“下一条消息使用的设置”，消息进入 Outbox 时固化，
 *   投递前仅在与 Agent 当前设置不同时写入一次。
 * - 读路径不阻塞：最近一次成功读取的模型状态按任务短期缓存，读取失败时回退到它，
 *   让临时网络或电脑响应慢不会被误报成“不能切换”。
 */

export type MobileTaskSettingsTimer = {
  mark(stage: string): void;
  summary(): string;
};

export function startMobileTaskSettingsTimer(now: () => number = Date.now): MobileTaskSettingsTimer {
  const startedAtMs = now();
  let lastAtMs = startedAtMs;
  const stages: string[] = [];
  return {
    mark(stage) {
      const at = now();
      stages.push(`${stage}=${at - lastAtMs}ms`);
      lastAtMs = at;
    },
    summary() {
      return [...stages, `total=${now() - startedAtMs}ms`].join(" ");
    },
  };
}

/** Agent 当前设置是否已满足要求；缺省字段视为不要求。 */
export function taskSettingsSatisfied(
  state: Pick<BridgeSessionModelState, "currentModel" | "currentReasoningEffort"> | null | undefined,
  settings: MobileNewTaskSettings,
): boolean {
  if (!state) return false;
  return (!settings.model || state.currentModel === settings.model) &&
    (!settings.reasoningEffort || state.currentReasoningEffort === settings.reasoningEffort);
}

type CachedModelState = { state: BridgeSessionModelState; cachedAtMs: number };

/** 按“Agent + 任务”缓存最近一次成功的模型状态，容量有限。 */
export class MobileTaskModelStateCache {
  private readonly entries = new Map<string, CachedModelState>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: { maxEntries?: number; now?: () => number } = {}) {
    this.maxEntries = options.maxEntries ?? 200;
    this.now = options.now ?? Date.now;
  }

  private key(adapter: string, threadId: string): string {
    return `${adapter}\0${threadId}`;
  }

  remember(adapter: string, threadId: string, state: BridgeSessionModelState): void {
    const key = this.key(adapter, threadId);
    this.entries.delete(key);
    this.entries.set(key, { state, cachedAtMs: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get(adapter: string, threadId: string, maxAgeMs: number): BridgeSessionModelState | null {
    const entry = this.entries.get(this.key(adapter, threadId));
    if (!entry || this.now() - entry.cachedAtMs > maxAgeMs) return null;
    return entry.state;
  }
}

/**
 * 读取失败时的回退：保留上次可用的列表与切换能力，只标记“暂未确认”。
 * 只有 Agent 明确声明不能切换才禁止选择；网络或响应慢不应该。
 */
export function staleModelStateFallback(
  cached: BridgeSessionModelState,
  error: unknown,
): BridgeSessionModelState & { stale: true; staleReason: string } {
  const message = error instanceof Error ? error.message : String(error);
  return { ...cached, stale: true, staleReason: message || "暂时无法确认电脑端的当前设置。" };
}
