import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenCodeServerAdapter } from "../../src/bridge/bridge-adapters.opencode.ts";
import { ReasonixServerAdapter } from "../../src/bridge/bridge-adapters.reasonix.ts";
import { WorkBuddyDesktopAdapter, type WorkBuddyAdapterDependencies } from "../../src/bridge/bridge-adapters.workbuddy.ts";
import { WeRelaySessionSettings } from "../../bin/opencode-session-settings-plugin.mjs";

const row = { id: "original", cwd: "/tmp", title: "任务", customTitle: null, status: "completed", createdAt: 1, updatedAt: 2, lastActivityAt: 2, projectId: null, permissionMode: "default" };
const options = (effort = "medium") => [{ id: "thought_level", type: "select", category: "thought_level", currentValue: effort, options: [{ value: "medium" }, { value: "high" }] }];

test("WorkBuddy confirms native settings instead of trusting a swallowed RPC failure", async () => {
  let model = "one", effort = "medium", reject = false;
  const calls: { channel: string; args: unknown[] }[] = [];
  const dependencies: WorkBuddyAdapterDependencies = {
    createDesktopClient: () => ({ connect: async () => undefined, close: async () => undefined,
      invoke: async (channel, ...args) => {
        calls.push({ channel, args });
        if (channel === "config:getProductConfiguration") return { models: [{ id: "one", displayName: "一" }, { id: "two" }, { id: "hidden" }], availableModels: ["one", "two"] };
        if (channel === "session:get") return { config: { model }, eventHistory: [{ update: { configOptions: options(effort) } }] };
        if (channel === "session:setModel" && !reject) model = args[1] as string;
        if (channel === "session:setConfigOption" && !reject) effort = args[2] as string;
        return { success: true };
      } }),
    listSessions: async () => [row], readSession: async () => row, readMessages: async () => [], readRunSummary: async () => null,
    readLocalImage: async () => ({ data: "", mimeType: "image/png" }),
  };
  const adapter = new WorkBuddyDesktopAdapter({ kind: "workbuddy", command: "fixture", cwd: "/tmp" }, dependencies) as any;
  await adapter.start();
  adapter.state.sharedSessionId = "original";
  expect(await adapter.getSessionModelState("original")).toMatchObject({ currentModel: "one", options: [{ id: "one" }, { id: "two" }] });
  expect(await adapter.setSessionModel("original", "two")).toMatchObject({ currentModel: "two" });
  expect(await adapter.setSessionReasoningEffort("original", "high")).toMatchObject({ currentReasoningEffort: "high" });
  expect(calls).toContainEqual({ channel: "session:setModel", args: ["original", "two"] });
  expect(calls).toContainEqual({ channel: "session:setConfigOption", args: ["original", "thought_level", "high"] });
  reject = true;
  await expect(adapter.setSessionModel("original", "one")).rejects.toThrow("未确认");
  expect(model).toBe("two");
  await expect(adapter.setSessionReasoningEffort("original", "medium")).rejects.toThrow("未确认");
  await adapter.dispose();
});

test("OpenCode persists original-session settings and enforces them for desktop and mobile prompts", async () => {
  let metadata: Record<string, unknown> = { existing: "keep" };
  let ignorePatch = false;
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const url = new URL(request.url); requests.push(`${request.method} ${url.pathname}`);
    if (url.pathname === "/provider") return Response.json({ connected: ["fixture"], all: [
      { id: "fixture", name: "测试供应商", models: { one: { name: "模型一", variants: { low: {}, high: {}, unsupported: { disabled: true } } }, two: { name: "模型二" } } },
      { id: "not-connected", models: { unavailable: {} } },
    ] });
    if (url.pathname === "/session/original/message") return Response.json([{ info: { role: "user", model: { providerID: "fixture", modelID: "two" } } }]);
    if (url.pathname === "/session/original") {
      if (request.method === "PATCH" && !ignorePatch) metadata = (await request.json()).metadata;
      return Response.json({ id: "original", metadata });
    }
    return new Response("Not found", { status: 404 });
  } });
  try {
    const adapter = new OpenCodeServerAdapter({ kind: "opencode", command: "fixture", cwd: "/tmp" }) as any;
    adapter.serverPort = server.port; adapter.activeSessionId = "original"; adapter.state.status = "idle";
    expect(await adapter.getSessionModelState("original")).toMatchObject({ currentModel: "fixture/two" });
    const state = await adapter.setSessionModel("original", "fixture/one");
    expect(state).toMatchObject({ currentModel: "fixture/one", reasoningEffortOptions: [{ id: "low" }, { id: "high" }] });
    expect(metadata.existing).toBe("keep");
    expect(await adapter.setSessionReasoningEffort("original", "high")).toMatchObject({ currentReasoningEffort: "high" });
    await expect(adapter.setSessionReasoningEffort("original", "unsupported")).rejects.toThrow();
    const plugin = await WeRelaySessionSettings({ client: { session: { get: async () => ({ data: { metadata } }) } } });
    const output = { message: { model: { providerID: "old", modelID: "old" }, variant: undefined }, parts: [] };
    await plugin["chat.message"]({ sessionID: "original" }, output);
    expect(output.message.model).toEqual({ providerID: "fixture", modelID: "one", variant: "high" });
    expect(output.message.variant).toBe("high");
    ignorePatch = true;
    await expect(adapter.setSessionModel("original", "fixture/two")).rejects.toThrow("未保存");
    await expect(adapter.setSessionModel("other-session", "fixture/one")).rejects.toThrow("请先打开");
    adapter.state.status = "busy";
    await expect(adapter.setSessionModel("original", "fixture/two")).rejects.toThrow("正在处理");
    expect(requests.some((entry) => /\/config|POST \/session$/.test(entry))).toBe(false);
  } finally { server.stop(true); }
});

test("reasonix uses the original serve model APIs, session fence, and capability-provided effort levels", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wr-reasonix-settings-"));
  const previous = process.env.REASONIX_HOME;
  process.env.REASONIX_HOME = dir;
  const sessionDir = path.join(dir, "sessions"); fs.mkdirSync(sessionDir, { recursive: true });
  const transcript = path.join(sessionDir, "original.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ role: "user", content: "fixture" }) + "\n");
  let model = "fixture/one", effort = "medium";
  let fencedPath = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/models") return Response.json({ current: model, models: [{ ref: "fixture/one", model: "one", provider: "fixture" }, { ref: "fixture/two", model: "two", provider: "fixture" }] });
    if (url.pathname === "/status") return Response.json({ running: false, effort: { supported: true, current: effort, levels: ["medium", "high"] } });
    fencedPath = request.headers.get("X-Reasonix-Expected-Session-Path") ?? "";
    const body = await request.json();
    if (url.pathname === "/model") model = body.ref;
    if (url.pathname === "/effort") effort = body.level;
    return new Response(null, { status: 204 });
  } });
  try {
    const adapter = new ReasonixServerAdapter({ kind: "reasonix", command: "fixture", cwd: dir }) as any;
    adapter.endpoint = `http://127.0.0.1:${server.port}`; adapter.state.sharedSessionId = "original"; adapter.state.status = "idle";
    expect(await adapter.setSessionModel("original", "fixture/two")).toMatchObject({ currentModel: "fixture/two" });
    expect(fencedPath).toBe(transcript);
    expect(await adapter.setSessionReasoningEffort("original", "high")).toMatchObject({ currentReasoningEffort: "high" });
    await expect(adapter.setSessionReasoningEffort("original", "max")).rejects.toThrow("不支持");
    await expect(adapter.setSessionModel("other-session", "fixture/one")).rejects.toThrow("请先打开");
  } finally {
    server.stop(true); if (previous === undefined) delete process.env.REASONIX_HOME; else process.env.REASONIX_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
