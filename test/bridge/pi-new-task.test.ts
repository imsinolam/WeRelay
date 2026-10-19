import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiOwnerAdapter } from "../../src/bridge/bridge-adapters.pi.ts";
import { discoverPiOwners } from "../../src/bridge/pi-owner-discovery.ts";

test("headless Pi creates in the existing project owner and can preselect models before attaching", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pi-new-"));
  const previous = { owners: process.env.WERELAY_PI_OWNER_DIRECTORY, sessions: process.env.PI_CODING_AGENT_SESSION_DIR };
  process.env.WERELAY_PI_OWNER_DIRECTORY = root;
  process.env.PI_CODING_AGENT_SESSION_DIR = root;
  const oldId = "12345678-1234-1234-1234-123456789abc";
  const newId = "22345678-1234-1234-1234-123456789abc";
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, { handler: (...args: any[]) => any }>();
  const prompts: string[] = [];
  let id = oldId;
  let draft = "";
  let idle = true;
  let created = 0;
  const context = { cwd: root, hasUI: true, sessionManager: { getSessionId: () => id }, isIdle: () => idle,
    hasPendingMessages: () => false, ui: { getEditorText: () => draft },
    model: { provider: "fixture", id: "before", reasoning: true },
    modelRegistry: { getAvailable: () => [{ provider: "fixture", id: "before", reasoning: true }] } };
  const adapter = new PiOwnerAdapter({ kind: "pi", command: "must-not-spawn", cwd: root, renderMode: "headless" });
  const send = (text: string, options?: { expandPromptTemplates?: boolean }) => {
    expect(options?.expandPromptTemplates).toBe(true);
    const [name, arg] = text.slice(1).split(" ");
    const command = commands.get(name!);
    if (!command) { prompts.push(text); return; }
    void command.handler(arg, { ...context, newSession: async (options: { withSession: (...args: any[]) => any }) => {
      created++; id = newId;
      handlers.get("session_start")?.({}, context);
      await options.withSession(context);
      return { cancelled: false };
    } });
  };
  try {
    const extension = (await import(`../../bin/pi-owner-extension.mjs?new=${Date.now()}`)).default;
    extension({ on: (name: string, cb: (...args: any[]) => any) => handlers.set(name, cb), registerCommand: (name: string, command: { handler: (...args: any[]) => any }) => commands.set(name, command), sendUserMessage: send });
    fs.writeFileSync(path.join(root, `source_${oldId}.jsonl`), JSON.stringify({ type: "session", version: 3, id: oldId, cwd: root, timestamp: new Date().toISOString() }) + "\n");
    handlers.get("session_start")?.({}, context);
    if (process.platform === "win32") {
      // Standalone Windows TUI discovery is intentionally unsupported. Verify
      // fail-closed behavior rather than expecting a POSIX owner socket.
      expect(discoverPiOwners(root)).toEqual([]);
      expect(commands.size).toBe(0);
      await adapter.start();
      expect(await adapter.getNewSessionModelState()).toMatchObject({ canChange: false, options: [] });
      await expect(adapter.createSessionInProject(oldId)).rejects.toThrow("没有已接入");
      expect(created).toBe(0);
      expect(prompts).toEqual([]);
      expect((adapter as unknown as { child: unknown }).child).toBeNull();
      return;
    }
    const deadline = Date.now() + 1500;
    while (!discoverPiOwners(root).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    await adapter.start();
    expect(await adapter.getNewSessionModelState()).toMatchObject({ canChange: true, options: [{ id: "fixture/before" }] });
    expect(adapter.getState().sharedSessionId).toBeUndefined(); // Catalog read must not change the task.
    idle = false;
    expect(await adapter.getNewSessionModelState()).toMatchObject({ canChange: true });
    idle = true;
    const other = path.join(root, "other");
    fs.mkdirSync(other);
    const otherId = "32345678-1234-1234-1234-123456789abc";
    fs.writeFileSync(path.join(root, `source_${otherId}.jsonl`), JSON.stringify({ type: "session", version: 3, id: otherId, cwd: other, timestamp: new Date().toISOString() }) + "\n");
    await expect(adapter.createSessionInProject(otherId)).rejects.toThrow("没有已接入");
    expect(created).toBe(0);
    draft = "unsent editor draft";
    await expect(adapter.createSessionInProject(oldId)).rejects.toThrow("尚未发送");
    expect(created).toBe(0);
    draft = ""; idle = false;
    await expect(adapter.createSessionInProject(oldId)).rejects.toThrow("正在运行");
    expect(created).toBe(0);
    idle = true;
    context.hasUI = false;
    await expect(adapter.createSessionInProject(oldId)).rejects.toThrow("Pi Desktop");
    expect(created).toBe(0);
    context.hasUI = true;
    await adapter.createSessionInProject(oldId);
    expect(adapter.getState()).toMatchObject({ sharedSessionId: newId, cwd: root });
    expect(created).toBe(1);
    expect(prompts).toEqual([]); // The control command never becomes a model prompt.
    expect((adapter as unknown as { child: unknown }).child).toBeNull();
  } finally {
    await adapter.dispose(); handlers.get("session_shutdown")?.({ reason: "quit" }, {});
    if (previous.owners === undefined) delete process.env.WERELAY_PI_OWNER_DIRECTORY; else process.env.WERELAY_PI_OWNER_DIRECTORY = previous.owners;
    if (previous.sessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = previous.sessions;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi draft models can be read from installed SDK without attaching or starting an agent", async () => {
  const { readPiInstalledModels } = await import("../../src/bridge/pi-model-catalog.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pi-sdk-models-"));
  try {
    const bundle = path.join(root, "dist", "bundle");
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module" }));
    const cli = path.join(bundle, "cli.js");
    fs.writeFileSync(cli, "throw new Error('Must not start a CLI');");
    fs.writeFileSync(path.join(bundle, "index.js"), `
      export class ModelRuntime { static async create(options) {
        if (options.allowModelNetwork !== false) throw new Error('Network must be disabled');
        return { getAvailableSnapshot: () => [{ provider:'fixture',id:'new-model',reasoning:true,thinkingLevelMap:{max:null,xhigh:null} }] };
      } }
    `);
    expect(await readPiInstalledModels(cli)).toMatchObject({ canChange: true, options: [{ id: "fixture/new-model", reasoningEffortOptions: [{ id: "off" }, { id: "minimal" }, { id: "low" }, { id: "medium" }, { id: "high" }] }] });
    expect(fs.readdirSync(root).sort()).toEqual(["dist", "package.json"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
