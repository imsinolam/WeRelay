import { expect, test } from "bun:test";
import { findIndependentPiProcessIds } from "../../src/bridge/bridge-adapters.pi.ts";
import { readPiSessionProject } from "../../src/bridge/pi-session-catalog.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("Pi resume refuses an independent TUI but excludes its own process", () => {
  const processes = [
    " 101 /opt/node /opt/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js --session /tmp/x",
    " 102 /opt/node /opt/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    " 103 node /project/werelay-daemon.js",
    " 104 pi --session /tmp/original.jsonl",
    " 105 zsh -c 'echo pi'",
  ].join("\n");
  expect(findIndependentPiProcessIds(processes, new Set([101]))).toEqual([102, 104]);
});

test("project creation reads native Pi header rather than inferring from filename", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pi-project-"));
  try {
    const file = path.join(root, "2026_12345678-1234-1234-1234-123456789abc.jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "session", id: "12345678-1234-1234-1234-123456789abc", timestamp: new Date().toISOString(), cwd: root }) + "\n");
    expect(await readPiSessionProject(file)).toBe(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Pi extra CLI arguments cannot override managed session or launch a headless writer", async () => {
  const { validatePiCliArgs } = await import("../../src/bridge/bridge-adapters.pi.ts");
  expect(validatePiCliArgs(["--model", "provider/model", "--thinking", "high"])).toEqual(["--model", "provider/model", "--thinking", "high"]);
  for (const args of [["--session", "/tmp/other"], ["--mode=rpc"], ["--print"], ["--", "prompt"]]) {
    expect(() => validatePiCliArgs(args)).toThrow(/Pi 启动参数/);
  }
});

test("Pi instant completion does not revert to stale busy after the send acknowledgement", async () => {
  const { PiOwnerAdapter } = await import("../../src/bridge/bridge-adapters.pi.ts");
  const adapter = new PiOwnerAdapter({ kind: "pi", command: "pi", cwd: process.cwd(), renderMode: "companion", initialSharedSessionId: "12345678-1234-1234-1234-123456789abc" });
  const events: Array<Record<string, unknown>> = [];
  adapter.setEventSink((event) => events.push(event as unknown as Record<string, unknown>));
  const internals = adapter as unknown as { token: string; socket: { destroyed: boolean; write: (text: string) => void }; handleRecord: (record: Record<string, unknown>) => void };
  internals.token = "secret";
  internals.socket = { destroyed: false, write: (text) => {
    const { id } = JSON.parse(text);
    queueMicrotask(() => {
      internals.handleRecord({ token: "secret", type: "agent_start", sessionId: adapter.getState().sharedSessionId });
      internals.handleRecord({ token: "secret", type: "settled", outcome: "error", sessionId: adapter.getState().sharedSessionId });
      internals.handleRecord({ token: "secret", type: "response", id, ok: true, queued: false });
    });
  } };
  await adapter.sendInputToSession("12345678-1234-1234-1234-123456789abc", "hello");
  expect(adapter.getState().status).toBe("idle");
  expect(events.find((event) => event.type === "task_complete")).toMatchObject({ outcome: "failed" });
});

test("Pi model failure emits a clear error rather than an empty final answer", async () => {
  const { PiOwnerAdapter } = await import("../../src/bridge/bridge-adapters.pi.ts");
  const sessionId = "12345678-1234-1234-1234-123456789abc";
  const adapter = new PiOwnerAdapter({ kind: "pi", command: "pi", cwd: process.cwd(), renderMode: "companion", initialSharedSessionId: sessionId });
  const events: Array<Record<string, unknown>> = [];
  adapter.setEventSink((event) => events.push(event as unknown as Record<string, unknown>));
  const internals = adapter as unknown as { token: string; handleRecord: (record: Record<string, unknown>) => void };
  internals.token = "secret";
  internals.handleRecord({ token: "secret", type: "agent_start", sessionId });
  internals.handleRecord({ token: "secret", type: "assistant_error", sessionId, error: "Connection error." });
  internals.handleRecord({ token: "secret", type: "settled", sessionId, outcome: "error" });
  expect(events.find((event) => event.type === "task_failed")).toMatchObject({
    message: "Pi 模型连接失败。请检查当前模型服务或网络后重试。",
  });
  expect(events.some((event) => event.type === "final_reply")).toBe(false);
  expect(events.find((event) => event.type === "task_complete")).toMatchObject({ outcome: "failed" });
  internals.handleRecord({ token: "secret", type: "agent_start", sessionId });
  internals.handleRecord({ token: "secret", type: "assistant", sessionId, text: "已恢复" });
  internals.handleRecord({ token: "secret", type: "settled", sessionId, outcome: "completed" });
  expect(events.filter((event) => event.type === "task_failed")).toHaveLength(1);
  expect(events.find((event) => event.type === "final_reply")).toMatchObject({ text: "已恢复" });
});

test("Pi project creation uses the native source project cwd even when another project is selected", async () => {
  const { PiOwnerAdapter } = await import("../../src/bridge/bridge-adapters.pi.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pi-project-route-"));
  const prev = process.env.PI_CODING_AGENT_SESSION_DIR;
  const project = path.join(root, "project");
  const other = path.join(root, "other");
  try {
    fs.mkdirSync(project); fs.mkdirSync(other);
    const bucket = path.join(root, "--project--"); fs.mkdirSync(bucket);
    const id = "12345678-1234-1234-1234-123456789abc";
    fs.writeFileSync(path.join(bucket, `2026_${id}.jsonl`), JSON.stringify({type: "session", version: 3, id, cwd: project, timestamp: new Date().toISOString()}) + "\n");
    process.env.PI_CODING_AGENT_SESSION_DIR = root;
    const matched = new PiOwnerAdapter({kind: "pi", cwd: project, command: "pi", renderMode: "companion"});
    let created = false;
    (matched as unknown as { restartOwner: (file?: string, cwd?: string) => Promise<void> }).restartOwner = async (_file, cwd) => { created = cwd === project; };
    await matched.createSessionInProject(id);
    expect(created).toBe(true);
    const mismatched = new PiOwnerAdapter({kind: "pi", cwd: other, command: "pi", renderMode: "companion"});
    let routedTo: string | undefined;
    (mismatched as unknown as { restartOwner: (file?: string, cwd?: string) => Promise<void> }).restartOwner = async (_file, cwd) => { routedTo = cwd; };
    await mismatched.createSessionInProject(id);
    expect(routedTo).toBe(project);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = prev;
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test("new empty Pi owner session remains selectable before the first native JSONL write", async () => {
  const { PiOwnerAdapter } = await import("../../src/bridge/bridge-adapters.pi.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pi-empty-"));
  const prev = process.env.PI_CODING_AGENT_SESSION_DIR;
  try {
    process.env.PI_CODING_AGENT_SESSION_DIR = root;
    const id = "12345678-1234-1234-1234-123456789abc";
    const adapter = new PiOwnerAdapter({ kind: "pi", command: "pi", cwd: root, renderMode: "companion", initialSharedSessionId: id });
    (adapter as unknown as { ownerSessionConfirmed: boolean }).ownerSessionConfirmed = true;
    expect(await adapter.listResumeSessions(10)).toMatchObject([{ sessionId: id, cwd: root }]);
    expect(await adapter.getSessionMessages(id)).toEqual([]);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = prev;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
