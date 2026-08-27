import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  WorkBuddyDesktopRpcClient,
  buildWorkBuddyDesktopHookSource,
  WORKBUDDY_BUNDLE_ID,
  ensureWorkBuddyDesktopHookFile,
  isWorkBuddyDesktopDaemonCommandLine,
  isWorkBuddyMainProcessCommandLine,
  resolveWorkBuddyDesktopSocketPath,
} from "../../src/bridge/workbuddy-desktop-rpc.ts";

async function withUnixServer(
  handler: (socket: net.Socket) => void,
  run: (socketPath: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "werelay-workbuddy-rpc-"));
  const socketPath = path.join(dir, "bridge.sock");
  const server = net.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    await run(socketPath);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

describe("WorkBuddy desktop RPC client", () => {
  test("distinguishes the WorkBuddy main process from app-server and sidecar children", () => {
    const executable = "/Applications/WorkBuddy.app/Contents/MacOS/Electron";
    const appAsar = "/Applications/WorkBuddy.app/Contents/Resources/app.asar";
    expect(isWorkBuddyMainProcessCommandLine(executable)).toBe(true);
    expect(isWorkBuddyMainProcessCommandLine(`${executable} ${appAsar}`)).toBe(true);
    expect(isWorkBuddyMainProcessCommandLine(
      `${executable} ${appAsar}/main/daemon-app-server-entry.js --stdio`,
    )).toBe(false);
    expect(isWorkBuddyMainProcessCommandLine(
      `${executable} ${appAsar}/main/sidecar-entry.js --token test`,
    )).toBe(false);
    expect(isWorkBuddyDesktopDaemonCommandLine(
      `${executable} ${appAsar}/main/daemon-app-server-entry.js --stdio`,
    )).toBe(true);
    expect(isWorkBuddyDesktopDaemonCommandLine(
      `${executable} ${appAsar}/main/sidecar-entry.js --token test`,
    )).toBe(false);
  });

  test("uses a per-user Unix socket path", () => {
    expect(resolveWorkBuddyDesktopSocketPath({
      uid: 501,
      tmpDir: "/tmp",
      platform: "darwin",
    }))
      .toBe("/tmp/werelay-workbuddy-501.sock");
    expect(resolveWorkBuddyDesktopSocketPath({ uid: 501, platform: "win32" }))
      .toBe("\\\\.\\pipe\\werelay-workbuddy-501");
    if (process.platform === "darwin") {
      expect(resolveWorkBuddyDesktopSocketPath({ uid: 501 }))
        .toBe("/tmp/werelay-workbuddy-501.sock");
    }
  });

  test("invokes the desktop daemon and receives events", async () => {
    const events: Array<{ channel: string; data: unknown }> = [];
    await withUnixServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const frame = JSON.parse(buffer.slice(0, newline)) as {
          id: string;
          channel: string;
          args: unknown[];
        };
        socket.write(`${JSON.stringify({
          type: "rpc-event",
          id: "event-1",
          channel: "session:event:wb-session",
          result: { sessionId: "wb-session", update: { sessionUpdate: "agent_message_chunk" } },
        })}\n`);
        socket.write(`${JSON.stringify({
          type: "rpc-response",
          id: frame.id,
          channel: frame.channel,
          result: { accepted: true, args: frame.args },
        })}\n`);
      });
    }, async (socketPath) => {
      const client = new WorkBuddyDesktopRpcClient({
        socketPath,
        connectTimeoutMs: 100,
        requestTimeoutMs: 1_000,
        callbacks: {
          onEvent: (channel, data) => events.push({ channel, data }),
        },
      });
      await client.connect();
      const result = await client.invoke("session:load", "wb-session", { cwd: "/repo" });
      expect(result).toEqual({ accepted: true, args: ["wb-session", { cwd: "/repo" }] });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual([{
        channel: "session:event:wb-session",
        data: { sessionId: "wb-session", update: { sessionUpdate: "agent_message_chunk" } },
      }]);
      await client.close();
    });
  });

  test("surfaces daemon RPC errors in Chinese-readable form", async () => {
    await withUnixServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", (chunk: string) => {
        const frame = JSON.parse(chunk.trim()) as { id: string; channel: string };
        socket.write(`${JSON.stringify({
          type: "rpc-error",
          id: frame.id,
          channel: frame.channel,
          error: { message: "WorkBuddy 当前任务不可用" },
        })}\n`);
      });
    }, async (socketPath) => {
      const client = new WorkBuddyDesktopRpcClient({
        socketPath,
        callbacks: { onEvent: () => undefined },
      });
      await client.connect();
      await expect(client.invoke("session:sendMessage", "wb-session", { content: [] }))
        .rejects.toThrow("WorkBuddy 当前任务不可用");
      await client.close();
    });
  });

  test("writes a private local hook without HTTP listeners", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "werelay-workbuddy-hook-"));
    const hookPath = path.join(dir, "hook.cjs");
    try {
      await ensureWorkBuddyDesktopHookFile(hookPath);
      const source = await fs.promises.readFile(hookPath, "utf8");
      const mode = (await fs.promises.stat(hookPath)).mode & 0o777;
      if (process.platform !== "win32") expect(mode).toBe(0o600);
      expect(source).toContain('require("node:net")');
      expect(source).toContain("fs.chmodSync(socketPath, 0o600)");
      expect(source).not.toContain('require("node:http")');
      expect(source).toBe(buildWorkBuddyDesktopHookSource());
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });


  test("uses the installed WorkBuddy bundle id for explicit restart", () => {
    expect(WORKBUDDY_BUNDLE_ID).toBe("com.tencent.workbuddy.mac");
  });

  test("automatically relaunches an already open WorkBuddy when the desktop hook is missing", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "werelay-workbuddy-restart-"));
    const socketPath = path.join(dir, "bridge.sock");
    let server: net.Server | null = null;
    let cleanupCount = 0;
    let launchCount = 0;
    let restartCount = 0;
    try {
      const client = new WorkBuddyDesktopRpcClient({
        socketPath,
        allowDesktopApplicationLaunch: true,
        callbacks: { onEvent: () => undefined },
        connectTimeoutMs: 500,
        connectPollIntervalMs: 5,
        existingProcessGraceMs: 0,
        lifecycle: {
          isRunning: async () => true,
          launch: async () => {
            launchCount += 1;
          },
          restart: async () => {
            restartCount += 1;
            server = net.createServer();
            await new Promise<void>((resolve, reject) => {
              server!.once("error", reject);
              server!.listen(socketPath, resolve);
            });
          },
          cleanup: async () => {
            cleanupCount += 1;
          },
        },
      });

      await client.connect();
      expect(restartCount).toBe(1);
      expect(launchCount).toBe(0);
      expect(cleanupCount).toBe(1);
      await client.close();
    } finally {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  test("waits briefly for an already instrumented WorkBuddy before deciding to restart it", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "werelay-workbuddy-grace-"));
    const socketPath = path.join(dir, "bridge.sock");
    let server: net.Server | null = null;
    let restartCount = 0;
    try {
      const client = new WorkBuddyDesktopRpcClient({
        socketPath,
        callbacks: { onEvent: () => undefined },
        connectTimeoutMs: 500,
        connectPollIntervalMs: 5,
        existingProcessGraceMs: 200,
        lifecycle: {
          isRunning: async () => {
            setTimeout(() => {
              server = net.createServer();
              server.listen(socketPath);
            }, 20);
            return true;
          },
          launch: async () => undefined,
          restart: async () => {
            restartCount += 1;
          },
        },
      });

      await client.connect();
      expect(restartCount).toBe(0);
      await client.close();
    } finally {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  test("does not launch or restart WorkBuddy without explicit user permission", async () => {
    for (const running of [false, true]) {
      let launchCount = 0;
      let restartCount = 0;
      const client = new WorkBuddyDesktopRpcClient({
        socketPath: `/tmp/werelay-workbuddy-disabled-${running}.sock`,
        callbacks: { onEvent: () => undefined },
        allowDesktopApplicationLaunch: false,
        connectTimeoutMs: 20,
        connectPollIntervalMs: 1,
        existingProcessGraceMs: 0,
        lifecycle: {
          isRunning: async () => running,
          launch: async () => {
            launchCount += 1;
          },
          restart: async () => {
            restartCount += 1;
          },
        },
      });

      await expect(client.connect()).rejects.toThrow("不会自动启动或重启 WorkBuddy");
      expect(launchCount).toBe(0);
      expect(restartCount).toBe(0);
      await client.close();
    }
  });

  test("bounds a stuck WorkBuddy restart by the overall connection timeout", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "werelay-workbuddy-timeout-"));
    const socketPath = path.join(dir, "bridge.sock");
    try {
      const client = new WorkBuddyDesktopRpcClient({
        socketPath,
        allowDesktopApplicationLaunch: true,
        callbacks: { onEvent: () => undefined },
        connectTimeoutMs: 50,
        connectPollIntervalMs: 5,
        existingProcessGraceMs: 0,
        lifecycle: {
          isRunning: async () => true,
          launch: async () => undefined,
          restart: async () => await new Promise<void>(() => undefined),
        },
      });

      const startedAt = Date.now();
      await expect(client.connect()).rejects.toThrow("WorkBuddy 自动重启超时");
      expect(Date.now() - startedAt).toBeLessThan(500);
      await client.close();
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});
