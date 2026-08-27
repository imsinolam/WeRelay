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

  test("restarts DSH only for an explicit user action", async () => {
    let writes = 0;
    let restarts = 0;
    const recovered = await recoverDeepSeekDesktopHarnessAccess({
      error: new Error("DeepSeek Harness host.describe transport failed: HTTP 403"),
      allowDesktopApplicationLaunch: true,
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
