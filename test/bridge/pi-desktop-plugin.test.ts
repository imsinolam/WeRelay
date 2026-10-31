import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { preparePiDesktopPlugin } from "../../src/bridge/pi-desktop-plugin.ts";
import { PiDesktopClient, PiDesktopUncertainError, readPiDesktopEndpoint } from "../../src/bridge/pi-desktop-client.ts";
import { PiDesktopAdapter } from "../../src/bridge/bridge-adapters.pi-desktop.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function pluginFixture(invoke?: (input: any) => Promise<unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-pi-plugin-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prepared = preparePiDesktopPlugin(dir);
  const calls: any[] = [];
  const module = { exports: {} as { onLoad(): Promise<void>; onUnload(): Promise<void> } };
  vm.runInNewContext(fs.readFileSync(path.join(prepared.directory, "main.cjs"), "utf8"), {
    require: createRequire(import.meta.url), module, process, Buffer, URL, setTimeout, clearTimeout,
    pi: { desktop: { listOperations: async () => [], invoke: async (input: unknown) => {
      calls.push(input);
      if (invoke) return invoke(input);
      return { ok: true, sessions: [{ id: "original-desktop", source: "desktop", title: "Fixture", updatedAt: "2026-10-30T00:00:00Z" }] };
    } } },
  });
  await module.exports.onLoad();
  cleanup.push(() => module.exports.onUnload());
  const endpoint = JSON.parse(fs.readFileSync(prepared.endpointFile, "utf8"));
  const client = new PiDesktopClient({ endpointFile: prepared.endpointFile,
    ...(process.platform === "win32" ? { readEndpoint: () => endpoint } : {}),
  });
  return { dir, prepared, endpoint, client, calls, plugin: module.exports };
}

test.skipIf(process.platform === "win32")("the packaged connector works with the native plugin lifecycle without enabling MCP or restarting Desktop", async () => {
  const f = await pluginFixture();
  if (process.platform !== "win32") expect(readPiDesktopEndpoint(f.prepared.endpointFile).pid).toBe(process.pid);
  expect(await f.client.invoke("app/health")).toMatchObject({ ok: true });
  expect(f.calls).toEqual([{ operation: "app/health", args: [] }]);
  const adapter = new PiDesktopAdapter({ kind: "pi-desktop", command: "pi-desktop", cwd: f.dir }, { client: f.client, pollIntervalMs: 0 });
  await adapter.start();
  expect(await adapter.listResumeSessions()).toMatchObject([{ sessionId: "original-desktop" }]);
  await adapter.dispose();
  await f.plugin.onUnload();
  expect(fs.existsSync(f.prepared.endpointFile)).toBe(false);
});

test.skipIf(process.platform === "win32")("connector accepts only authenticated local MCP sessions and its reviewed operation allowlist", async () => {
  const f = await pluginFixture();
  const denied = await fetch(f.endpoint.url, { method: "POST", body: "{}" });
  expect(denied.status).toBe(401); await denied.text();
  const fromWeb = await fetch(f.endpoint.url, { method: "POST", headers: { authorization: `Bearer ${f.endpoint.token}`, origin: "https://example.com" }, body: "{}" });
  expect(fromWeb.status).toBe(403); await fromWeb.text();
  await expect(f.client.invoke("session/configure", ["original-desktop", { permissionMode: "bypass" }])).rejects.toThrow();
  await expect(f.client.invoke("session/delete", ["original-desktop"])).rejects.toThrow();
  expect(f.calls).toEqual([]);
  await expect(f.client.invoke("agent/prompt", [{ sessionId: "native-pi:cli", content: "wrong owner" }])).rejects.toThrow();
  expect(f.calls).toEqual([]);
});

test("preparation is idempotent, private and never edits Desktop settings or another plugin", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-pi-prepare-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (process.platform === "win32") {
    expect(() => preparePiDesktopPlugin(dir)).toThrow("Windows");
    expect(fs.readdirSync(dir)).toEqual([]);
    return;
  }
  const prepared = preparePiDesktopPlugin(dir);
  expect(preparePiDesktopPlugin(dir)).toEqual(prepared);
  const manifest = JSON.parse(fs.readFileSync(path.join(prepared.directory, "manifest.json"), "utf8"));
  expect(manifest.permissions).toEqual(["desktop.control"]);
  expect(manifest.main).toBe("main.cjs");
  expect(fs.existsSync(prepared.endpointFile)).toBe(false);
  expect(prepared.message).toContain(prepared.directory);
  expect(prepared.message).toContain("安装");
  if (process.platform !== "win32") {
    expect(fs.statSync(prepared.directory).mode & 0o077).toBe(0);
    expect(fs.statSync(path.join(prepared.directory, "main.cjs")).mode & 0o077).toBe(0);
  }
  fs.writeFileSync(path.join(prepared.directory, "manifest.json"), JSON.stringify({ id: "someone.else" }));
  expect(() => preparePiDesktopPlugin(dir)).toThrow("未覆盖");
});

test.skipIf(process.platform === "win32")("default client can discover the plugin endpoint while MCP is disabled", async () => {
  const f = await pluginFixture();
  const client = new PiDesktopClient({ endpointFiles: [path.join(f.dir, "missing-mcp.json"), f.prepared.endpointFile],
    ...(process.platform === "win32" ? { readEndpoint: () => f.endpoint } : {}),
  });
  expect(await client.invoke("session/list")).toMatchObject({ sessions: [{ id: "original-desktop" }] });
});

test.skipIf(process.platform === "win32")("explicit connection prepares the user-approved plugin, while background listing remains read-only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-pi-first-connect-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = { data: process.env.WERELAY_DATA_DIR, desktop: process.env.WERELAY_PI_DESKTOP_DATA_DIR };
  process.env.WERELAY_DATA_DIR = dir;
  process.env.WERELAY_PI_DESKTOP_DATA_DIR = path.join(dir, "desktop");
  try {
    const adapter = new PiDesktopAdapter({ kind: "pi-desktop", command: "pi-desktop", cwd: dir });
    await expect(adapter.listResumeSessions()).rejects.toThrow("werelay-pi-desktop-enable");
    expect(fs.readdirSync(dir)).toEqual([]);
    await expect(adapter.start()).rejects.toThrow("插件管理");
    expect(fs.existsSync(path.join(dir, "plugins", "pi-desktop-connector", "manifest.json"))).toBe(true);
    expect(adapter.getState().status).toBe("stopped");
    expect(fs.existsSync(path.join(dir, "plugins", "pi-desktop-connector", "control.json"))).toBe(false);
    await adapter.dispose();
  } finally {
    if (previous.data === undefined) delete process.env.WERELAY_DATA_DIR; else process.env.WERELAY_DATA_DIR = previous.data;
    if (previous.desktop === undefined) delete process.env.WERELAY_PI_DESKTOP_DATA_DIR; else process.env.WERELAY_PI_DESKTOP_DATA_DIR = previous.desktop;
  }
});

test.skipIf(process.platform === "win32")("a Desktop error after accepting a prompt never releases the watch for a second send", async () => {
  let prompts = 0;
  const f = await pluginFixture(async ({ operation }) => {
    if (operation === "session/get") return { session: { id: "original-desktop", source: "desktop", messages: [] } };
    if (operation === "agent/getStatus") return { isRunning: false };
    if (operation === "agent/prompt") { prompts++; throw new Error("native response lost after acceptance"); }
    return { ok: true };
  });
  const adapter = new PiDesktopAdapter({ kind: "pi-desktop", command: "pi-desktop", cwd: f.dir }, { client: f.client, pollIntervalMs: 0 });
  cleanup.push(() => adapter.dispose());
  await expect(adapter.sendInputToSession("original-desktop", "hello")).rejects.toBeInstanceOf(PiDesktopUncertainError);
  await expect(adapter.sendInputToSession("original-desktop", "hello")).rejects.toThrow("尚未结束或确认");
  expect(prompts).toBe(1);
});
