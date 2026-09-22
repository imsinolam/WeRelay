import type { BridgeAdapter } from "../bridge/bridge-types.ts";

export type MobileNewTaskSettings = { model?: string; reasoningEffort?: string };

export function parseMobileNewTaskSettings(value: unknown): MobileNewTaskSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("新任务模型设置无效。");
  const input = value as Record<string, unknown>;
  const settings: MobileNewTaskSettings = {};
  for (const key of ["model", "reasoningEffort"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > (key === "model" ? 200 : 80)) {
      throw new Error("新任务模型或推理强度无效，请重新选择。");
    }
    settings[key] = input[key].trim();
  }
  return Object.keys(settings).length ? settings : undefined;
}

export async function applyMobileNewTaskSettings(
  runtime: Pick<BridgeAdapter, "setSessionModel" | "setSessionReasoningEffort">,
  threadId: string,
  settings: MobileNewTaskSettings,
): Promise<void> {
  if (settings.model) {
    if (!runtime.setSessionModel) throw new Error("当前终端不支持预选新任务模型。");
    const state = await runtime.setSessionModel(threadId, settings.model);
    if (state.currentModel !== settings.model) throw new Error("新任务模型尚未生效，消息已保留。");
  }
  if (settings.reasoningEffort) {
    if (!runtime.setSessionReasoningEffort) throw new Error("当前终端不支持预选推理强度。");
    const state = await runtime.setSessionReasoningEffort(threadId, settings.reasoningEffort);
    if (state.currentReasoningEffort !== settings.reasoningEffort) throw new Error("新任务推理强度尚未生效，消息已保留。");
  }
}
