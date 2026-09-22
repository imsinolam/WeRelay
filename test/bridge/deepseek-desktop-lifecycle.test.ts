import { describe, expect, test } from "bun:test";

import {
  DEEPSEEK_DESKTOP_BUNDLE_ID,
  enableDeepSeekDesktopLoopbackAccessInYaml,
  recoverDeepSeekDesktopHarnessAccess,
} from "../../src/bridge/deepseek-desktop-lifecycle.ts";

describe("DeepSeek Desktop lifecycle", () => {
  test("uses the installed DSH Desktop bundle id", () => {
    expect(DEEPSEEK_DESKTOP_BUNDLE_ID).toBe("ai.deepseek.dsh.desktop");
  });

  test("enables official loopback browser access without changing unrelated settings", () => {
    const source = [
      "llm-deepseek:",
      "  thinking: enabled",
      "",
    ].join("\n");

    expect(enableDeepSeekDesktopLoopbackAccessInYaml(source)).toEqual({
      changed: true,
      text: [
        "llm-deepseek:",
        "  thinking: enabled",
        "",
        "dsh-desktop:",
        "  mode: compatibility",
        "  openBrowser: true",
        "  networkExposure: loopback",
        "",
      ].join("\n"),
    });
  });

  test("updates an existing compatibility block and preserves nearby settings", () => {
    const source = [
      "dsh-desktop:",
      "  mode: compatibility",
      "  openBrowser: false",
      "  networkExposure: loopback",
      "  macosMaterial: transparent",
      "vision-router:",
      "  routing: false",
      "",
    ].join("\n");

    const result = enableDeepSeekDesktopLoopbackAccessInYaml(source);
    expect(result.changed).toBe(true);
    expect(result.text).toContain("  openBrowser: true");
    expect(result.text).toContain("  networkExposure: loopback");
    expect(result.text).toContain("  macosMaterial: transparent");
    expect(result.text).toContain("vision-router:\n  routing: false");
  });

  test("does not silently replace a non-compatibility desktop shell", () => {
    expect(() => enableDeepSeekDesktopLoopbackAccessInYaml([
      "dsh-desktop:",
      "  mode: advanced",
      "  openBrowser: false",
      "",
    ].join("\n"))).toThrow("兼容模式");
  });

  test("launches an installed but closed DSH Desktop for an explicit switch", async () => {
    let launches = 0;
    let restarts = 0;
    let writes = 0;
    const recovered = await recoverDeepSeekDesktopHarnessAccess({
      error: new Error("connect ECONNREFUSED 127.0.0.1:43120"),
      allowDesktopApplicationLaunch: true,
      dependencies: {
        platform: "darwin",
        appExists: () => true,
        isRunning: async () => false,
        readSettings: () => "",
        writeSettings: () => {
          writes += 1;
        },
        launch: async () => {
          launches += 1;
        },
        restart: async () => {
          restarts += 1;
        },
      },
    });

    expect(recovered).toBe(true);
    expect(launches).toBe(1);
    expect(restarts).toBe(0);
    expect(writes).toBe(0);
  });

  test("does not restart a running DSH Desktop for a transient transport failure", async () => {
    let launches = 0;
    let restarts = 0;
    const recovered = await recoverDeepSeekDesktopHarnessAccess({
      error: new Error("fetch failed"),
      allowDesktopApplicationLaunch: true,
      dependencies: {
        platform: "darwin",
        appExists: () => true,
        isRunning: async () => true,
        readSettings: () => "",
        writeSettings: () => undefined,
        launch: async () => {
          launches += 1;
        },
        restart: async () => {
          restarts += 1;
        },
      },
    });

    expect(recovered).toBe(false);
    expect(launches).toBe(0);
    expect(restarts).toBe(0);
  });

  test("a switch never restarts a running Desktop even for HTTP 403", async () => {
    const effects: string[] = [];
    expect(await recoverDeepSeekDesktopHarnessAccess({
      error: new Error("host.describe transport failed: HTTP 403"),
      allowDesktopApplicationLaunch: true,
      dependencies: {
        platform: "darwin",
        appExists: () => true,
        isRunning: async () => true,
        readSettings: () => { effects.push("read"); return ""; },
        writeSettings: () => { effects.push("write"); },
        launch: async () => { effects.push("launch"); },
        restart: async () => { effects.push("restart"); },
      },
    })).toBe(false);
    expect(effects).toEqual([]);
  });

  test("explicitly configured Harness endpoints never launch the Desktop", async () => {
    for (const name of ["WERELAY_DEEPSEEK_HARNESS_URL", "DESKRELAY_DEEPSEEK_HARNESS_URL"]) {
      const previous = process.env[name];
      process.env[name] = "http://127.0.0.1:9000";
      const effects: string[] = [];
      try {
        expect(await recoverDeepSeekDesktopHarnessAccess({
          error: new Error("fetch failed"),
          allowDesktopApplicationLaunch: true,
          dependencies: {
            platform: "darwin",
            appExists: () => true,
            isRunning: async () => false,
            readSettings: () => "",
            writeSettings: () => { effects.push("write"); },
            launch: async () => { effects.push("launch"); },
            restart: async () => { effects.push("restart"); },
          },
        })).toBe(false);
        expect(effects).toEqual([]);
      } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    }
  });

  test("an unchanged access setting is not a reason to restart for stale authentication", async () => {
    let restarts = 0;
    const settings = enableDeepSeekDesktopLoopbackAccessInYaml("").text;
    expect(await recoverDeepSeekDesktopHarnessAccess({
      error: new Error("HTTP 403"),
      allowDesktopApplicationLaunch: true,
      allowDesktopApplicationRestart: true,
      dependencies: {
        platform: "darwin",
        appExists: () => true,
        isRunning: async () => true,
        readSettings: () => settings,
        writeSettings: () => { throw new Error("settings must not change"); },
        launch: async () => undefined,
        restart: async () => { restarts += 1; },
      },
    })).toBe(false);
    expect(restarts).toBe(0);
  });

  test("restarts DSH only for an explicitly authorized settings repair", async () => {
    let writes = 0;
    let restarts = 0;
    const recovered = await recoverDeepSeekDesktopHarnessAccess({
      error: new Error("DeepSeek Harness host.describe transport failed: HTTP 403"),
      allowDesktopApplicationLaunch: true,
      allowDesktopApplicationRestart: true,
      dependencies: {
        platform: "darwin",
        appExists: () => true,
        isRunning: async () => true,
        readSettings: () => "llm-deepseek:\n  thinking: enabled\n",
        writeSettings: () => {
          writes += 1;
        },
        launch: async () => undefined,
        restart: async () => {
          restarts += 1;
        },
      },
    });

    expect(recovered).toBe(true);
    expect(writes).toBe(1);
    expect(restarts).toBe(1);

    expect(await recoverDeepSeekDesktopHarnessAccess({
      error: new Error("fetch failed"),
      allowDesktopApplicationLaunch: false,
      dependencies: {
        platform: "darwin",
        appExists: () => true,
        isRunning: async () => true,
        readSettings: () => "",
        writeSettings: () => undefined,
        launch: async () => undefined,
        restart: async () => undefined,
      },
    })).toBe(false);
  });
});
