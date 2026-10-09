import { expect, test } from "bun:test";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const extensionUrl = new URL("../../bin/pi-owner-extension.mjs", import.meta.url);

test("Pi extension accepts authenticated prompt in real owner, queues follow-up, and refuses wrong session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pi-ext-"));
  const endpoint = path.join(dir, "owner.sock");
  const previous = { endpoint: process.env.WERELAY_PI_OWNER_SOCKET, token: process.env.WERELAY_PI_OWNER_TOKEN };
  const received: Record<string, unknown>[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const prompts: unknown[][] = [];
  let peer: net.Socket | undefined;
  let idle = true;
  let draft = "";
  let sessionId = "12345678-1234-1234-1234-123456789abc";
  const models = [
    { provider: "anthropic", id: "sonnet", name: "Sonnet", reasoning: true, thinkingLevelMap: { xhigh: null, max: null } },
    { provider: "openai", id: "gpt", name: "GPT", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: null } },
  ];
  let currentModel = models[0];
  let canAuthenticate = true;
  let thinkingLevel = "medium";
  const server = net.createServer((socket) => {
    peer = socket;
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        received.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
  });
  const waitFor = async (type: string, id?: string) => {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const value = received.find((r) => r.type === type && (id === undefined || r.id === id));
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${type}`);
  };
  try {
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    process.env.WERELAY_PI_OWNER_SOCKET = endpoint;
    process.env.WERELAY_PI_OWNER_TOKEN = "secret";
    const extension = (await import(`${extensionUrl.href}?t=${Date.now()}`)).default;
    extension({ on: (name: string, cb: (event: unknown, ctx: unknown) => void) => handlers.set(name, cb),
      sendUserMessage: (...args: unknown[]) => prompts.push(args),
      getThinkingLevel: () => thinkingLevel,
      setThinkingLevel: (level: string) => { thinkingLevel = level; },
      setModel: async (model: typeof models[number]) => {
        if (!canAuthenticate) return false;
        currentModel = model; return true;
      },
    });
    const context = {
      sessionManager: { getSessionId: () => sessionId },
      isIdle: () => idle, abort: () => undefined, ui: { getEditorText: () => draft },
      modelRegistry: { getAvailable: () => models },
      get model() { return currentModel; },
    };
    handlers.get("session_start")?.({}, context);
    expect(await waitFor("ready")).toMatchObject({ sessionId, token: "secret" });
    peer?.write(JSON.stringify({ id: "model-list", token: "secret", type: "model_state", sessionId }) + "\n");
    expect(await waitFor("response", "model-list")).toMatchObject({
      ok: true, modelState: {
        currentModel: "anthropic/sonnet", canChange: true,
        options: [{ id: "anthropic/sonnet" }, { id: "openai/gpt" }],
      },
    });
    peer?.write(JSON.stringify({ id: "invalid-model", token: "secret", type: "set_model", sessionId, model: "unknown/model" }) + "\n");
    expect(await waitFor("response", "invalid-model")).toMatchObject({ ok: false });
    peer?.write(JSON.stringify({ id: "change-model", token: "secret", type: "set_model", sessionId, model: "openai/gpt" }) + "\n");
    expect(await waitFor("response", "change-model")).toMatchObject({ ok: true, modelState: { currentModel: "openai/gpt" } });
    peer?.write(JSON.stringify({ id: "effort", token: "secret", type: "set_reasoning", sessionId, model: "xhigh" }) + "\n");
    expect(await waitFor("response", "effort")).toMatchObject({ ok: true, modelState: { currentReasoningEffort: "xhigh", canChangeReasoningEffort: true } });
    expect(thinkingLevel).toBe("xhigh");
    peer?.write(JSON.stringify({ id: "bad-effort", token: "secret", type: "set_reasoning", sessionId, model: "max" }) + "\n");
    expect(await waitFor("response", "bad-effort")).toMatchObject({ ok: false });
    expect(thinkingLevel).toBe("xhigh");
    canAuthenticate = false;
    peer?.write(JSON.stringify({ id: "no-auth", token: "secret", type: "set_model", sessionId, model: "anthropic/sonnet" }) + "\n");
    expect(await waitFor("response", "no-auth")).toMatchObject({ ok: false, error: expect.stringContaining("认证") });
    expect(currentModel).toEqual(models[1]);
    canAuthenticate = true;
    const request = (id: string, target = sessionId, token = "secret") => peer?.write(JSON.stringify({ id, token, type: "prompt", sessionId: target, text: "hello" }) + "\n");
    request("first");
    expect(await waitFor("response", "first")).toMatchObject({ ok: true, queued: false });
    expect(prompts).toEqual([["hello", undefined]]);
    draft = "unsent text";
    peer?.write(JSON.stringify({ id: "guard-draft", token: "secret", type: "can_switch", sessionId }) + "\n");
    expect(await waitFor("response", "guard-draft")).toMatchObject({ ok: false, error: "Pi 编辑区有尚未发送的内容。" });
    draft = "";
    idle = false;
    peer?.write(JSON.stringify({ id: "busy-effort", token: "secret", type: "set_reasoning", sessionId, model: "low" }) + "\n");
    expect(await waitFor("response", "busy-effort")).toMatchObject({ ok: false });
    expect(thinkingLevel).toBe("xhigh");
    peer?.write(JSON.stringify({ id: "busy-model", token: "secret", type: "set_model", sessionId, model: "anthropic/sonnet" }) + "\n");
    expect(await waitFor("response", "busy-model")).toMatchObject({ ok: false });
    request("second");
    expect(await waitFor("response", "second")).toMatchObject({ ok: true, queued: true });
    expect(prompts[1]).toEqual(["hello", { deliverAs: "followUp" }]);
    peer?.write(JSON.stringify({ id: "guard-busy", token: "secret", type: "can_switch", sessionId }) + "\n");
    expect(await waitFor("response", "guard-busy")).toMatchObject({ ok: false, error: "Pi 正在运行。" });
    request("wrong-session", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(await waitFor("response", "wrong-session")).toMatchObject({ ok: false });
    expect(prompts).toHaveLength(2);
    handlers.get("message_end")?.({ message: {
      role: "assistant", stopReason: "error", errorMessage: "Connection error.", content: [],
    } }, {});
    expect(await waitFor("assistant_error")).toMatchObject({
      sessionId, error: "Connection error.",
    });
    handlers.get("agent_before_settle")?.({ outcome: "error" }, {});
    handlers.get("agent_settled")?.({}, {});
    expect(await waitFor("settled")).toMatchObject({ outcome: "error", run: { status: "failed" } });
    sessionId = "22222222-2222-2222-2222-222222222222";
    handlers.get("session_start")?.({ reason: "new" }, { sessionManager: { getSessionId: () => sessionId }, isIdle: () => true, abort: () => undefined });
    const deadline = Date.now() + 1500;
    while (!received.some((r) => r.type === "session" && r.sessionId === sessionId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(received.filter((r) => r.type === "session").at(-1)).toMatchObject({ sessionId });
    request("invalid-token", sessionId, "wrong");
    await new Promise<void>((resolve) => peer?.once("close", resolve));
    expect(prompts).toHaveLength(2);
  } finally {
    peer?.destroy(); server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous.endpoint === undefined) delete process.env.WERELAY_PI_OWNER_SOCKET;
    else process.env.WERELAY_PI_OWNER_SOCKET = previous.endpoint;
    if (previous.token === undefined) delete process.env.WERELAY_PI_OWNER_TOKEN;
    else process.env.WERELAY_PI_OWNER_TOKEN = previous.token;
  }
});
