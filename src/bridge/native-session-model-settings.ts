import { isRecord } from "./bridge-adapter-common.ts";
import type { BridgeSessionModelOption, BridgeSessionModelState } from "./bridge-types.ts";

export function reasoningSettingLabel(id: string): string {
  return ({ off: "关闭推理", none: "关闭推理", disabled: "关闭推理", enabled: "开启推理", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高", ultra: "超高", auto: "自动" } as Record<string, string>)[id] ?? id;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 240 ? value.trim() : undefined;
}

/** Keep the native catalog and config identifiers; never invent model capabilities. */
export class NativeSessionModelSettings {
  private models: BridgeSessionModelOption[] = [];
  private currentModel?: string;
  private configs: Record<string, unknown>[] = [];

  ingest(value: unknown): void {
    if (!isRecord(value)) return;
    const catalog = isRecord(value.models) ? value.models : isRecord(value.modelsInfo) ? value.modelsInfo : value;
    if (Array.isArray(catalog.availableModels)) {
      this.models = catalog.availableModels.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const id = string(entry.modelId) ?? string(entry.id);
        return id ? [{ id, label: string(entry.name) ?? id }] : [];
      });
    }
    const nextModel = string(catalog.currentModelId);
    if (nextModel && nextModel !== this.currentModel) this.clearReasoning();
    this.currentModel = nextModel ?? this.currentModel;
    if (Array.isArray(value.configOptions)) {
      this.configs = structuredClone(value.configOptions.filter(isRecord));
      const model = this.config("model");
      if (model) {
        this.currentModel = string(model.currentValue) ?? this.currentModel;
        this.models = this.options(model).map((option) => ({ id: option.id, label: option.label }));
      }
    }
    if (isRecord(value.config)) this.currentModel = string(value.config.model) ?? this.currentModel;
    if (isRecord(value.update)) this.ingest(value.update);
    if (Array.isArray(value.eventHistory)) {
      for (const event of value.eventHistory) this.ingest(event);
    }
  }

  private config(category: "model" | "thought_level"): Record<string, unknown> | undefined {
    return this.configs.find((entry) => entry.type === "select" &&
      (entry.category === category || (category === "thought_level" && ["thought_level", "thinking", "reasoning_effort"].includes(String(entry.id ?? entry.configId)))));
  }

  private options(config: Record<string, unknown>): Array<{ id: string; label: string }> {
    const flatten = (entries: unknown[]): Array<{ id: string; label: string }> => entries.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      if (Array.isArray(entry.options)) return flatten(entry.options);
      const id = string(entry.value);
      return id ? [{ id, label: string(entry.name) ?? id }] : [];
    });
    return Array.isArray(config.options) ? flatten(config.options) : [];
  }

  state(canChange = true, reason = "任务正在处理，完成或停止后再调整设置。"): BridgeSessionModelState {
    const reasoning = this.config("thought_level");
    const efforts = reasoning ? this.options(reasoning).map((entry) => ({ id: entry.id, label: reasoningSettingLabel(entry.id) })) : [];
    return {
      currentModel: this.currentModel,
      options: this.models.map((entry) => ({ ...entry })),
      canChange: canChange && this.models.length > 0,
      unavailableReason: !canChange ? reason : !this.models.length ? "当前终端未提供可用模型列表，请更新或在电脑端检查配置。" : undefined,
      currentReasoningEffort: string(reasoning?.currentValue),
      reasoningEffortOptions: efforts,
      canChangeReasoningEffort: canChange && efforts.length > 0,
      reasoningEffortUnavailableReason: !canChange ? reason : !efforts.length ? "当前模型或终端版本未提供推理强度设置。" : undefined,
    };
  }

  modelRequest(model: string): { method: string; params: Record<string, unknown> } {
    if (!this.models.some((entry) => entry.id === model)) throw new Error("所选模型不在当前终端的可用列表中，请刷新设置。");
    const config = this.config("model");
    return config
      ? { method: "session/set_config_option", params: { configId: config.id ?? config.configId, value: model } }
      : { method: "session/set_model", params: { modelId: model } };
  }

  reasoningRequest(effort: string): { method: string; params: Record<string, unknown> } {
    const config = this.config("thought_level");
    if (!config || !this.options(config).some((entry) => entry.id === effort)) throw new Error("当前模型不支持所选推理强度，请刷新设置。");
    return { method: "session/set_config_option", params: { configId: config.id ?? config.configId, value: effort } };
  }

  private clearReasoning(): void {
    const reasoning = this.config("thought_level");
    this.configs = this.configs.filter((entry) => entry !== reasoning);
  }

  confirmModel(model: string): void {
    if (model !== this.currentModel) this.clearReasoning();
    this.currentModel = model;
    const config = this.config("model");
    if (config) config.currentValue = model;
  }

  confirmReasoning(effort: string): void {
    const config = this.config("thought_level");
    if (config) config.currentValue = effort;
  }
}
