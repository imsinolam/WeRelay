import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createBridgeAdapter } from "../../src/bridge/bridge-adapters.ts";
import {
  GrokAcpAdapter,
  parseGrokChatHistory,
  buildGrokAcpArgs,
  buildGrokNativeArgs,
  isGrokLeaderCommandLine,
  listGrokStoredSessions,
  parseGrokLeaderSocketOwnerPids,
  resolveGrokLeaderSocket,
  selectGrokLeaderSocketOwnerPids,
} from "../../src/bridge/bridge-adapters.grok.ts";
import { LocalCompanionProxyAdapter } from "../../src/bridge/bridge-adapters.core.ts";

const cwd = path.resolve("/tmp/werelay-grok-project");

describe("Grok shared owner adapter", () => {
  test("uses the local companion proxy on the bridge side", () => {
    const adapter = createBridgeAdapter({
      kind: "grok",
      command: "grok",
      cwd,
    });

    expect(adapter).toBeInstanceOf(LocalCompanionProxyAdapter);
  });

  test("runs the real Grok adapter inside the visible companion", () => {
    const adapter = createBridgeAdapter({
      kind: "grok",
      command: "grok",
      cwd,
      renderMode: "companion",
    });

    expect(adapter).toBeInstanceOf(GrokAcpAdapter);
  });

  test("connects ACP and the visible TUI to the same leader socket", () => {
    const socket = "/tmp/werelay-grok-test.sock";
    const options = {
      kind: "grok" as const,
      command: "grok",
      cwd,
      profile: "/tmp/profile.toml",
      extraCliArgs: ["--always-approve"],
    };

    expect(buildGrokAcpArgs(options, socket)).toEqual([
      "agent",
      "--leader",
      "--leader-socket",
      socket,
      "--agent-profile",
      "/tmp/profile.toml",
      "stdio",
    ]);
    expect(buildGrokNativeArgs(options, socket, "session-123")).toEqual([
      "--leader-socket",
      socket,
      "--resume",
      "session-123",
      "--always-approve",
    ]);
  });

  test("uses a short deterministic per-workspace socket", () => {
    const first = resolveGrokLeaderSocket(cwd, { platform: "darwin", uid: 501 });
    const second = resolveGrokLeaderSocket(cwd, { platform: "darwin", uid: 501 });
    const other = resolveGrokLeaderSocket(`${cwd}-other`, { platform: "darwin", uid: 501 });

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toStartWith("/tmp/werelay-grok-501-");
    expect(first.length).toBeLessThan(100);
  });

  test("finds only processes that hold the exact Grok leader socket", () => {
    const target = "/tmp/werelay-grok-501-target.sock";
    const lsofOutput = [
      "p101",
      "fcwd",
      "n/Users/example/project",
      "f22",
      `n${target}`,
      "p202",
      "f19",
      "n/tmp/werelay-grok-501-other.sock",
      "p303",
      "f7",
      `n${target}.backup`,
    ].join("\n");

    expect(parseGrokLeaderSocketOwnerPids(lsofOutput, target)).toEqual([101]);
  });

  test("recognizes Grok leader commands without confusing visible Grok clients", () => {
    expect(isGrokLeaderCommandLine(
      "/Users/example/.grok/bin/grok agent leader --no-exit-on-disconnect",
    )).toBe(true);
    expect(isGrokLeaderCommandLine("grok --leader-socket /tmp/example.sock")).toBe(false);
    expect(isGrokLeaderCommandLine(
      "/bin/zsh -lc 'echo grok agent leader --leader-socket /tmp/example.sock'",
    )).toBe(false);
  });

  test("recovers only exact socket owners whose process is a Grok leader", () => {
    const target = "/tmp/werelay-grok-501-target.sock";
    const lsofOutput = [
      "p101",
      "f22",
      `n${target}`,
      "p202",
      "f23",
      `n${target}`,
      "p303",
      "f24",
      "n/tmp/werelay-grok-501-other.sock",
    ].join("\n");
    const commandLines = new Map([
      [101, "/Users/example/.grok/bin/grok agent leader --no-exit-on-disconnect"],
      [202, "/Users/example/.grok/bin/grok --leader-socket /tmp/example.sock"],
      [303, "/Users/example/.grok/bin/grok agent leader --no-exit-on-disconnect"],
    ]);

    expect(selectGrokLeaderSocketOwnerPids(target, lsofOutput, commandLines))
      .toEqual([101]);
  });

  test("does not unlink a leader socket owned by another visible Grok client", async () => {
    if (process.platform === "win32") return;
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-grok-owner-"));
    const socketPath = resolveGrokLeaderSocket(tempCwd);
    fs.writeFileSync(socketPath, "external-owner", "utf8");
    const adapter = new GrokAcpAdapter({
      kind: "grok",
      command: "grok",
      cwd: tempCwd,
      renderMode: "companion",
    });
    const internal = adapter as unknown as { stopOwnedLeader(): Promise<void> };
    try {
      await internal.stopOwnedLeader();
      expect(fs.existsSync(socketPath)).toBe(true);
    } finally {
      fs.rmSync(socketPath, { force: true });
      fs.rmSync(tempCwd, { recursive: true, force: true });
    }
  });

  test("attaches generated image tool results to the preceding assistant message without duplicating image reads", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-grok-image-"));
    const imagePath = path.join(tempDir, "images", "3.jpg");
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    try {
      const messages = parseGrokChatHistory([
        JSON.stringify({ type: "assistant", content: "图片已经生成。", model_id: "grok-4" }),
        JSON.stringify({
          type: "tool_result",
          content: JSON.stringify({
            path: imagePath,
            filename: "3.jpg",
            session_folder: "images",
            message: "Image edited and saved",
          }),
        }),
        JSON.stringify({ type: "assistant", content: "" }),
        JSON.stringify({ type: "tool_result", content: `Read image file: ${imagePath}` }),
      ].join("\n"));

      expect(messages).toEqual([{
        role: "assistant",
        text: "图片已经生成。",
        phase: "final_answer",
        model: "grok-4",
        images: [{ source: "local", path: imagePath, alt: "3.jpg" }],
      }]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("uses stored Grok history while the visible companion is still starting", async () => {
    const expected = [{
      role: "assistant" as const,
      text: "图片已生成",
      images: [{ source: "local" as const, path: "/tmp/generated.png" }],
    }];
    const adapter = new LocalCompanionProxyAdapter({
      kind: "grok",
      command: "grok",
      cwd,
    }, {
      readSessionMessages: async (_cwd, sessionId) =>
        sessionId === "stored-session" ? expected : [],
    });

    expect(await adapter.getSessionMessages("stored-session")).toEqual(expected);
    expect(await adapter.getSessionMessageMedia("stored-session")).toEqual(expected);
    expect(await adapter.getLatestSessionMessage("stored-session")).toEqual(expected[0]);
  });

  test("does not use the cwd folder as a project name for stored Grok tasks", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-grok-history-"));
    const previous = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const sessionId = "grok-session";
      const sessionDir = path.join(
        home,
        "sessions",
        encodeURIComponent("/repo/grok-project"),
        sessionId,
      );
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, "summary.json"), JSON.stringify({
        info: { id: sessionId, cwd: "/repo/grok-project" },
        generated_title: "Grok 自动标题",
        updated_at: "2026-08-28T01:00:00.000Z",
      }));

      expect(listGrokStoredSessions(10)).toMatchObject([{
        sessionId,
        title: "Grok 自动标题",
        cwd: "/repo/grok-project",
      }]);
      expect(listGrokStoredSessions(10)[0]?.projectName).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("detects a running standalone Grok turn from the live process event file", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-grok-running-"));
    const previous = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const sessionId = "grok-running-session";
      const sessionDir = path.join(
        home,
        "sessions",
        encodeURIComponent("/repo/grok-project"),
        sessionId,
      );
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, "summary.json"), JSON.stringify({
        info: { id: sessionId, cwd: "/repo/grok-project" },
        generated_title: "正在运行的 Grok 任务",
        updated_at: "2026-08-28T05:00:00.000Z",
      }));
      const eventsPath = path.join(sessionDir, "events.jsonl");
      fs.writeFileSync(eventsPath, [
        JSON.stringify({
          ts: "2026-08-28T05:00:00.000Z",
          type: "turn_started",
          session_id: sessionId,
        }),
        JSON.stringify({
          ts: "2026-08-28T05:00:01.000Z",
          type: "phase_changed",
          phase: "waiting_for_model",
        }),
      ].join("\n"));

      expect(listGrokStoredSessions(10, { liveEventPaths: [] })[0]?.runtimeStatus)
        .toEqual({ type: "notLoaded" });
      expect(listGrokStoredSessions(10, { liveEventPaths: [eventsPath] })[0]?.runtimeStatus)
        .toEqual({ type: "active", activeFlags: [] });

      fs.appendFileSync(eventsPath, `\n${JSON.stringify({
        ts: "2026-08-28T05:00:02.000Z",
        type: "permission_requested",
        tool_name: "run_terminal_command",
      })}`);
      expect(listGrokStoredSessions(10, { liveEventPaths: [eventsPath] })[0]?.runtimeStatus)
        .toEqual({ type: "active", activeFlags: [] });

      fs.appendFileSync(eventsPath, `\n${JSON.stringify({
        ts: "2026-08-28T05:00:03.000Z",
        type: "permission_resolved",
        tool_name: "run_terminal_command",
        decision: "allow",
      })}\n${JSON.stringify({
        ts: "2026-08-28T05:00:04.000Z",
        type: "turn_ended",
        outcome: "completed",
      })}`);
      expect(listGrokStoredSessions(10, { liveEventPaths: [eventsPath] })[0]?.runtimeStatus)
        .toEqual({ type: "idle" });
    } finally {
      if (previous === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

});
