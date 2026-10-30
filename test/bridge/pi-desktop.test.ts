import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { PiDesktopClient, readPiDesktopEndpoint, type PiDesktopEndpoint } from "../../src/bridge/pi-desktop-client.ts";
import { PiDesktopAdapter } from "../../src/bridge/bridge-adapters.pi-desktop.ts";
import { getBridgeProvider } from "../../src/bridge/bridge-providers.ts";
import { parseDaemonSwitchCommand, detectOpenMobileAdaptersFromProcessList } from "../../src/daemon/werelay-daemon.ts";
import type { BridgeEvent } from "../../src/bridge/bridge-types.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-pi-desktop-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls: { operation: string; args: unknown[] }[] = [];
  let running = false;
  const messages = [{ id: "u0", role: "user", content: "earlier", createdAt: "2026-10-28T00:00:00Z", status: "complete" }];
  const session = { id: "desktop-task", source: "desktop", title: "Desktop task", projectPath: dir, updatedAt: "2026-10-28T00:00:00Z" };
  const server = http.createServer(async (req, res) => {
    expect(req.headers.authorization).toBe(`Bearer ${"a".repeat(64)}`);
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    res.setHeader("Content-Type", "application/json");
    if (body.method === "initialize") {
      res.setHeader("Mcp-Session-Id", "test-session");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } })); return;
    }
    expect(req.headers["mcp-session-id"]).toBe("test-session");
    if (body.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
    const { operation, args } = body.params.arguments;
    calls.push({ operation, args });
    let result: unknown;
    if (operation === "app/health") result = { ok: true };
    else if (operation === "session/list") result = { sessions: [session, { ...session, id: "native-pi:cli", source: "native-pi" }] };
    else if (operation === "session/get") result = args[0].id === session.id ? { session: { ...session, messages, hasMoreBefore: false, messageStart: 0 } } : { session: null };
    else if (operation === "agent/getStatus") result = { isRunning: running, turnId: "turn-1" };
    else if (operation === "agent/prompt") { running = true; messages.push({ id: "u1", role: "user", content: args[0].content, createdAt: "2026-10-28T01:00:00Z", status: "complete" }); result = { turnId: "turn-1" }; }
    else if (operation === "agent/abort") { running = false; result = { ok: true }; }
    else throw new Error(`Unexpected operation ${operation}`);
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { operation, result } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as { port: number }).port;
  const file = path.join(dir, "mcp-control.json");
  fs.writeFileSync(file, JSON.stringify({ active: true, url: `http://127.0.0.1:${port}/mcp`, token: "a".repeat(64), pid: process.pid }), { mode: 0o600 });
  const client = new PiDesktopClient({
    endpointFile: file,
    // The wire protocol is tested on every OS, but Windows discovery must stay
    // closed until the production reader can verify native Windows ACLs.
    ...(process.platform === "win32" ? {
      readEndpoint: () => JSON.parse(fs.readFileSync(file, "utf8")) as PiDesktopEndpoint,
    } : {}),
  });
  return { dir, file, client, calls, finish() { running = false; messages.push({ id: "a1", role: "assistant", content: "Desktop reply", status: "complete", createdAt: "2026-10-28T01:01:00Z" }); } };
}

test("Pi Agent and Pi Desktop have different commands, owners and process detection", () => {
  expect(parseDaemonSwitchCommand("/pi")).toBe("pi");
  expect(parseDaemonSwitchCommand("/pi-desktop")).toBe("pi-desktop");
  expect(parseDaemonSwitchCommand("/pi desktop")).toBe("pi-desktop");
  expect(getBridgeProvider("pi-desktop").sessionIntegration.owner).toBe("desktop_owner");
  expect([...detectOpenMobileAdaptersFromProcessList("123 /Applications/PI-Desktop.app/Contents/MacOS/PI-Desktop")]).toEqual(["pi-desktop"]);
});

test("ClawBot accepts the case-insensitive Pi Desktop shorthand without confusing Pi Agent", () => {
  for (const command of ["/pi-d", "/PI-D", "/Pi-D", "  /pi-d  "]) {
    expect(parseDaemonSwitchCommand(command)).toBe("pi-desktop");
  }
  expect(parseDaemonSwitchCommand("/pi-d 20")).toEqual({ adapter: "pi-desktop", pageSize: 20 });
  expect(parseDaemonSwitchCommand("/PI-D\u300015")).toEqual({ adapter: "pi-desktop", pageSize: 15 });
  expect(parseDaemonSwitchCommand("/pi")).toBe("pi");
  expect(parseDaemonSwitchCommand("/pi agent")).toBe("pi");
  expect(parseDaemonSwitchCommand("/pi-debug")).toBeNull();
});

test("discovery rejects unsafe credentials, remote endpoints, dead owner and symlink", async () => {
  const f = await fixture();
  if (process.platform === "win32") {
    expect(() => readPiDesktopEndpoint(f.file)).toThrow("Windows");
    return;
  }
  expect(readPiDesktopEndpoint(f.file).pid).toBe(process.pid);
  const original = fs.readFileSync(f.file, "utf8");
  for (const patch of [{ url: "https://example.com/mcp" }, { url: "http://127.0.0.1:3/other" }, { active: false }, { pid: 2147483647 }, { token: "invalid" }]) {
    fs.writeFileSync(f.file, JSON.stringify({ ...JSON.parse(original), ...patch }));
    expect(() => readPiDesktopEndpoint(f.file)).toThrow();
  }
  fs.writeFileSync(f.file, original); fs.chmodSync(f.file, 0o644);
  expect(() => readPiDesktopEndpoint(f.file)).toThrow();
  fs.chmodSync(f.file, 0o600);
  const link = path.join(f.dir, "link.json"); fs.symlinkSync(f.file, link);
  expect(() => readPiDesktopEndpoint(link)).toThrow();
});

test("Windows discovery fails closed instead of pretending POSIX modes verify Windows ACLs", async () => {
  const f = await fixture();
  expect(() => readPiDesktopEndpoint(f.file, "win32")).toThrow("Windows");
});

test("list/read/resume never open a desktop task or spawn a CLI; missing task cannot silently fork", async () => {
  const f = await fixture();
  const adapter = new PiDesktopAdapter({ kind: "pi-desktop", command: "pi-desktop", cwd: f.dir }, { client: f.client, pollIntervalMs: 0 });
  cleanup.push(() => adapter.dispose());
  await adapter.start();
  expect(await adapter.listResumeSessions()).toMatchObject([{ sessionId: "desktop-task", title: "Desktop task" }]);
  expect((await adapter.listResumeSessions()).length).toBe(1);
  await adapter.resumeSession("desktop-task");
  expect(await adapter.getSessionMessages("desktop-task")).toMatchObject([{ id: "u0", text: "earlier" }]);
  await expect(adapter.resumeSession("missing")).rejects.toThrow();
  await expect(adapter.sendInputToSession("native-pi:cli", "hello")).rejects.toThrow();
  expect(adapter.getState().sharedSessionId).toBe("desktop-task");
  expect(f.calls.every((call) => ["app/health", "session/list", "session/get"].includes(call.operation))).toBe(true);
});

test("messages, completion and stop use the exact desktop owner with no old reply replay", async () => {
  const f = await fixture(); const events: BridgeEvent[] = [];
  const adapter = new PiDesktopAdapter({ kind: "pi-desktop", command: "pi-desktop", cwd: f.dir }, { client: f.client, pollIntervalMs: 0 });
  cleanup.push(() => adapter.dispose()); adapter.setEventSink((event) => events.push(event));
  await adapter.start();
  expect(await adapter.sendInputToSession("desktop-task", "hello")).toMatchObject({ turnId: "turn-1" });
  await adapter.poll();
  expect(events.filter((event) => event.type === "final_reply")).toHaveLength(0);
  f.finish(); await adapter.poll(); await adapter.poll();
  expect(events.filter((event) => event.type === "final_reply")).toMatchObject([{ text: "Desktop reply", threadId: "desktop-task", messageId: "a1", origin: "wechat" }]);
  await adapter.interruptSession("desktop-task");
  expect(f.calls.find((call) => call.operation === "agent/prompt")?.args).toEqual([{ sessionId: "desktop-task", content: "hello" }]);
  expect(f.calls.find((call) => call.operation === "agent/abort")?.args).toEqual([{ sessionId: "desktop-task" }]);
});

test("missing control plane fails closed without disturbing Pi Agent", async () => {
  const client = new PiDesktopClient({ endpointFile: "/nonexistent/werelay-test/mcp-control.json" });
  const adapter = new PiDesktopAdapter({ kind: "pi-desktop", command: "pi-desktop", cwd: "/tmp" }, { client });
  await expect(adapter.start()).rejects.toThrow("不会重启");
  expect(adapter.getState().status).toBe("stopped");
  expect(getBridgeProvider("pi").sessionIntegration.owner).toBe("visible_cli_owner");
  expect(getBridgeProvider("pi-desktop").capabilities.approvals).toBe(false);
});

test("concurrent sends cannot create duplicate turns and desktop approval cannot be bypassed", async () => {
  const f = await fixture();
  const adapter = new PiDesktopAdapter({ kind: "pi-desktop", command: "pi-desktop", cwd: f.dir }, { client: f.client, pollIntervalMs: 0 });
  cleanup.push(() => adapter.dispose());
  const results = await Promise.allSettled([adapter.sendInputToSession("desktop-task", "one"), adapter.sendInputToSession("desktop-task", "two")]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(f.calls.filter((call) => call.operation === "agent/prompt")).toHaveLength(1);
  await expect(adapter.resolveApproval("confirm")).rejects.toThrow("桌面原窗口");
  await expect(adapter.submitUserInput({ answer: ["yes"] })).rejects.toThrow("原窗口");
  expect(f.calls.some((call) => /Permission|resolve|configure/.test(call.operation))).toBe(false);
});

test("desktop history uses native bounded cursors, not a silently truncated complete history", async () => {
  const calls: unknown[] = [];
  const adapter = new PiDesktopAdapter({ kind: "pi-desktop", command: "pi-desktop", cwd: "/tmp" }, { pollIntervalMs: 0, client: {
    async invoke(operation, args) {
      calls.push({ operation, args });
      return { session: { id: "task", source: "desktop", messages: [{ id: "u", role: "user", content: "hello" }], hasMoreBefore: true, messageStart: 100 } };
    },
  } });
  const page = await adapter.getSessionMessagePage("task", { limit: 40 });
  expect(page).toMatchObject({ hasMore: true, nextBefore: "100", messages: [{ id: "u" }] });
  await adapter.getSessionMessagePage("task", { before: page.nextBefore, limit: 20 });
  expect(calls.at(-1)).toMatchObject({ operation: "session/get", args: [{ id: "task", messageBefore: 100, messageLimit: 20 }] });
  await expect(adapter.getSessionMessagePage("task", { before: "not-a-cursor" })).rejects.toThrow();
});

test("uncertain sends are not replayed and stale final messages cannot complete a new turn", async () => {
  const { PiDesktopUncertainError } = await import("../../src/bridge/pi-desktop-client.ts");
  let sends = 0;
  const events: BridgeEvent[] = [];
  const adapter = new PiDesktopAdapter({ kind: "pi-desktop", command: "pi-desktop", cwd: "/tmp" }, { pollIntervalMs: 0, client: {
    async invoke(operation) {
      if (operation === "agent/prompt") { sends++; throw new PiDesktopUncertainError("ambiguous"); }
      if (operation === "agent/getStatus") return { isRunning: false };
      return { session: { id: "task", source: "desktop", messages: [{ id: "old", role: "assistant", content: "old result", status: "complete" }] } };
    },
  } });
  adapter.setEventSink((event) => events.push(event));
  await expect(adapter.sendInputToSession("task", "new")).rejects.toThrow("ambiguous");
  await adapter.poll();
  await expect(adapter.sendInputToSession("task", "new")).rejects.toThrow("尚未结束或确认");
  expect(sends).toBe(1); expect(events.filter((event) => event.type === "final_reply")).toHaveLength(0);
});

test("authenticated mobile API routes list, history, send and stop to Pi Desktop", async () => {
  const { startCodexMobileServer } = await import("../../src/daemon/codex-mobile-server.ts");
  const { CodexMobileAuthStore } = await import("../../src/daemon/codex-mobile-auth.ts");
  const f = await fixture();
  const adapter = new PiDesktopAdapter({ kind: "pi-desktop", command: "pi-desktop", cwd: f.dir }, { client: f.client, pollIntervalMs: 0 });
  cleanup.push(() => adapter.dispose());
  const authStore = new CodexMobileAuthStore({ stateFile: path.join(f.dir, "web-auth.json") });
  authStore.setPassword("fixture-password-only");
  const server = await startCodexMobileServer({ host: "127.0.0.1", port: 0, lanAddress: "127.0.0.1", accessToken: "fixture-only", authStore,
    listTasks: async (provider) => {
      expect(provider).toBe("pi-desktop");
      return (await adapter.listResumeSessions()).map((candidate) => ({ threadId: candidate.sessionId, title: candidate.title, lastUpdatedAt: candidate.lastUpdatedAt, status: "idle" as const }));
    },
    readMessages: async (id, options, provider) => {
      expect(provider).toBe("pi-desktop");
      const page = await adapter.getSessionMessagePage(id, options);
      return { threadId: id, messages: page.messages, messagePage: page, queuedMessages: [] };
    },
    sendMessage: async (id, input, provider) => {
      expect(provider).toBe("pi-desktop");
      return { ...await adapter.sendInputToSession(id, input.text), queued: false };
    },
    stopTask: async (id, provider) => { expect(provider).toBe("pi-desktop"); return adapter.interruptSession(id); },
  });
  try {
    const root = `http://127.0.0.1:${server.port}`;
    const headers = { cookie: `codex_mobile_session=${authStore.createSessionToken()}`, "content-type": "application/json" };
    const denied = await fetch(`${root}/api/tasks?adapter=pi-desktop`);
    expect(denied.status).toBe(401); await denied.text();
    const list = await fetch(`${root}/api/tasks?adapter=pi-desktop`, { headers });
    expect(list.status).toBe(200); expect(JSON.stringify(await list.json())).toContain("Desktop task");
    const history = await fetch(`${root}/api/tasks/desktop-task/messages?adapter=pi-desktop`, { headers });
    expect(history.status).toBe(200); expect(JSON.stringify(await history.json())).toContain("earlier");
    const send = await fetch(`${root}/api/tasks/desktop-task/messages?adapter=pi-desktop`, { method: "POST", headers, body: JSON.stringify({ clientId: "fixture-send", text: "web hello" }) });
    expect(send.status).toBe(202); await send.text();
    const stop = await fetch(`${root}/api/tasks/desktop-task/stop?adapter=pi-desktop`, { method: "POST", headers });
    expect(stop.status).toBe(200); await stop.text();
    expect(f.calls.filter((call) => call.operation === "agent/prompt")).toHaveLength(1);
  } finally {
    await server.close();
  }
});

test("create and rename operate on Desktop only and preserve project identity", async () => {
  const calls: { operation: string; args?: unknown[] }[] = [];
  const adapter = new PiDesktopAdapter({ kind: "pi-desktop", command: "pi-desktop", cwd: "/tmp/initial" }, { pollIntervalMs: 0, client: {
    async invoke(operation, args) {
      calls.push({ operation, args });
      if (operation === "session/create") return { session: { id: "new-task", source: "desktop", projectPath: "/tmp/original" } };
      if (operation === "session/get") return { session: { id: (args?.[0] as { id: string }).id, source: "desktop", projectPath: "/tmp/original", messages: [] } };
      if (operation === "session/rename") return { ok: true };
      throw new Error("unexpected write");
    },
  } });
  await adapter.createSessionInProject("original");
  expect(adapter.getState().sharedSessionId).toBe("new-task");
  expect(calls.find((call) => call.operation === "session/create")?.args).toEqual([{ projectPath: "/tmp/original" }]);
  await adapter.renameSession("new-task", "Renamed");
  expect(calls.at(-1)).toEqual({ operation: "session/rename", args: ["new-task", "Renamed"] });
  expect(calls.some((call) => call.operation === "session/open")).toBe(false);
});

test("long turns still complete when the native history page no longer includes the user input", async () => {
  let sent = false;
  const events: BridgeEvent[] = [];
  const adapter = new PiDesktopAdapter({ kind: "pi-desktop", command: "pi-desktop", cwd: "/tmp" }, { pollIntervalMs: 0, client: {
    async invoke(operation) {
      if (operation === "agent/prompt") { sent = true; return { turnId: "long-turn" }; }
      if (operation === "agent/getStatus") return { isRunning: false };
      return { session: { id: "long", source: "desktop", messageStart: sent ? 200 : 0,
        messages: [{ id: sent ? "new-final" : "old-final", role: "assistant", content: sent ? "done" : "old", status: "complete" }] } };
    },
  } });
  adapter.setEventSink((event) => events.push(event));
  await adapter.sendInputToSession("long", "run"); await adapter.poll();
  expect(events.filter((event) => event.type === "final_reply")).toMatchObject([{ text: "done", threadId: "long", turnId: "long-turn" }]);
});

test("control client rejects redirects without sending bearer credentials to a second endpoint", async () => {
  const f = await fixture(); let redirected = 0; let writes = 0;
  const target = http.createServer((_req, res) => { redirected++; res.end("{}"); });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => target.close(() => resolve())));
  const targetPort = (target.address() as { port: number }).port;
  const redirect = http.createServer((_req, res) => { writes++; res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/mcp` }); res.end(); });
  await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { redirect.closeAllConnections(); redirect.close(() => resolve()); }));
  const endpoint = JSON.parse(fs.readFileSync(f.file, "utf8"));
  endpoint.url = `http://127.0.0.1:${(redirect.address() as { port: number }).port}/mcp`;
  fs.writeFileSync(f.file, JSON.stringify(endpoint));
  await expect(f.client.invoke("session/list")).rejects.toThrow();
  expect(writes).toBe(1); expect(redirected).toBe(0);
});
