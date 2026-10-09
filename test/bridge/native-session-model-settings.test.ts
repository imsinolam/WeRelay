import { describe, expect, test } from "bun:test";
import { NativeSessionModelSettings } from "../../src/bridge/native-session-model-settings.ts";
import { parseCliSettingsMenu } from "../../src/bridge/cli-settings-menu.ts";
import { AcpBridgeAdapter, type AcpTransportCallbacks } from "../../src/bridge/bridge-adapters.acp.ts";
import { LocalCompanionProxyAdapter } from "../../src/bridge/bridge-adapters.core.ts";

const configs = (model = "one", effort = "medium") => [
  { id: "model", type: "select", category: "model", currentValue: model,
    options: [{ name: "供应商", options: [{ value: "one", name: "模型一" }, { value: "two", name: "模型二" }] }] },
  { id: "thinking", type: "select", category: "thought_level", currentValue: effort,
    options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
];

describe("native session model settings", () => {
  test("maps native grouped catalogs and thinking ids without inventing options", () => {
    const settings = new NativeSessionModelSettings();
    settings.ingest({ configOptions: configs() });
    expect(settings.state()).toMatchObject({ currentModel: "one", canChange: true,
      currentReasoningEffort: "medium", reasoningEffortOptions: [{ id: "medium", label: "中" }, { id: "high", label: "高" }] });
    expect(settings.reasoningRequest("high")).toEqual({ method: "session/set_config_option", params: { configId: "thinking", value: "high" } });
    expect(() => settings.reasoningRequest("max")).toThrow();
    expect(() => settings.modelRequest("not-installed")).toThrow();
    expect(settings.state(false)).toMatchObject({ canChange: false, canChangeReasoningEffort: false });
  });
  test("clears model-specific effort capabilities after native model changes", () => {
    const settings = new NativeSessionModelSettings();
    const original = configs(); settings.ingest({ configOptions: original });
    settings.confirmReasoning("high"); expect(original[1]!.currentValue).toBe("medium");
    settings.ingest({ currentModelId: "two" });
    expect(settings.state()).toMatchObject({ currentModel: "two", reasoningEffortOptions: [], canChangeReasoningEffort: false });
    expect(() => settings.reasoningRequest("high")).toThrow();
  });
  test("uses legacy native model selection and consumes external changes", () => {
    const settings = new NativeSessionModelSettings();
    settings.ingest({ models: { currentModelId: "one", availableModels: [{ modelId: "one", name: "一" }, { modelId: "two" }] } });
    expect(settings.modelRequest("two")).toEqual({ method: "session/set_model", params: { modelId: "two" } });
    settings.ingest({ update: { sessionUpdate: "model_update", currentModelId: "two", availableModels: [{ modelId: "two" }] } });
    expect(settings.state()).toMatchObject({ currentModel: "two", options: [{ id: "two" }], canChangeReasoningEffort: false });
  });
  test.each(["grok", "codebuddy"] as const)("%s changes the original ACP session and retains failed selections", async (kind) => {
    const calls: Record<string, unknown>[] = [];
    let callbacks: AcpTransportCallbacks;
    let selectedModel = "one";
    let selectedEffort = "medium";
    let rejectSetting = false;
    const adapter = new AcpBridgeAdapter({ kind, command: "fixture", cwd: "/tmp", sessionStartMode: "new" }, {
      kind, buildArgs: () => [], createTransport: (_options, _cwd, _env, cb) => {
        callbacks = cb;
        return { pid: 12345, start: async () => undefined, dispose: async () => undefined,
          send: async (message) => {
            calls.push(message);
            const params = message.params as Record<string, string>;
            if (message.method === "session/set_config_option") {
              if (rejectSetting) { callbacks.message({ id: message.id, error: { message: "native rejected" } }); return; }
              if (params.configId === "model") selectedModel = params.value!;
              else selectedEffort = params.value!;
            }
            callbacks.message({ id: message.id, result: message.method === "initialize" ? {} : {
              sessionId: "original", configOptions: configs(selectedModel, selectedEffort),
            } });
          } };
      },
    });
    try {
      await adapter.start();
      expect(await adapter.setSessionModel("original", "two")).toMatchObject({ currentModel: "two" });
      expect(await adapter.setSessionReasoningEffort("original", "high")).toMatchObject({ currentReasoningEffort: "high" });
      expect(calls.filter((call) => call.method === "session/set_config_option").map((call) => call.params)).toEqual([
        { sessionId: "original", configId: "model", value: "two" }, { sessionId: "original", configId: "thinking", value: "high" },
      ]);
      rejectSetting = true;
      await expect(adapter.setSessionModel("original", "one")).rejects.toThrow("native rejected");
      expect(await adapter.getSessionModelState("original")).toMatchObject({ currentModel: "two" });
      await expect(adapter.setSessionModel("another-task", "one")).rejects.toThrow("请先打开");
      callbacks!.message({ method: "session/update", params: { sessionId: "original", update: { sessionUpdate: "config_option_update", configOptions: configs("one", "medium") } } });
      expect(await adapter.getSessionModelState("original")).toMatchObject({ currentModel: "one", currentReasoningEffort: "medium" });
      expect(calls.filter((call) => call.method === "session/new")).toHaveLength(1);
    } finally { await adapter.dispose(); }
  });
  test("companion forwards model and reasoning settings to the same visible owner", async () => {
    const adapter = new LocalCompanionProxyAdapter({ kind: "grok", command: "fixture", cwd: "/tmp" }) as any;
    const commands: unknown[] = [];
    adapter.sendRequest = async (payload: unknown) => { commands.push(payload); return { options: [], canChange: true }; };
    await adapter.getSessionModelState("original");
    await adapter.setSessionModel("original", "two");
    await adapter.setSessionReasoningEffort("original", "high");
    expect(commands).toEqual([
      { command: "get_session_model_state", sessionId: "original" },
      { command: "set_session_model", sessionId: "original", model: "two" },
      { command: "set_session_reasoning_effort", sessionId: "original", reasoningEffort: "high" },
    ]);
  });
  test("reads Claude native menus including the actual ANSI effort slider", () => {
    expect(parseCliSettingsMenu("❯1.Default(recommended)✔\n2.Opus(1Mcontext)\n3.Sonnet\n4.Sonnet5(1Mcontext)\n5.Haiku", "model")).toMatchObject({ current: "default", options: [
      { id: "default" }, { id: "opus[1m]" }, { id: "sonnet" }, { id: "sonnet[1m]" }, { id: "haiku" },
    ] });
    expect(parseCliSettingsMenu("\u001b[25G────────────────────▲────\n\u001b[25Glow\u001b[33Gmedium\u001b[44Ghigh\u001b[53Gxhigh\u001b[64Gmax\u001b[74Gultracode", "effort")).toMatchObject({ current: "high", options: [
      { id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" },
    ] });
    expect(parseCliSettingsMenu("No effort supported for this model", "effort").options).toEqual([]);
  });
});
