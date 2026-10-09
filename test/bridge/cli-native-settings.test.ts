import { expect, test } from "bun:test";
import { CliSettingsScreen } from "../../src/bridge/cli-settings-screen.ts";
import { parseCliSettingsMenu } from "../../src/bridge/cli-settings-menu.ts";
import { ClaudeCompanionAdapter } from "../../src/bridge/bridge-adapters.claude.ts";

test("native settings screen retains unchanged characters across cursor-based redraws", () => {
  const screen = new CliSettingsScreen();
  screen.write("\u001b[HEnter to set as default · s to use this session only");
  const label = "Enter to set as default · s to use this session only";
  screen.write(["t", "u", "e"].map((char) => `\u001b[1;${label.lastIndexOf(char) + 1}H${char}`).join(""));
  expect(screen.text()).toContain("s to use this session only");
  screen.reset();
  screen.write("\u001b[H                    ▲\r\nlow     medium     high     xhigh    max\r\n");
  expect(parseCliSettingsMenu(screen.text(), "effort")).toMatchObject({ current: "high", options: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }] });
  screen.write("\u001b[1;1H\u001b[2K▲");
  expect(parseCliSettingsMenu(screen.text(), "effort").current).toBe("low");
  screen.write("\u001b[2J\u001b[Hempty"); expect(screen.text()).toBe("empty");
});

test("Claude and TClaude settings use native session-only confirmation and never alter defaults", async () => {
  for (const kind of ["claude", "tclaude"] as const) {
    const adapter = new ClaudeCompanionAdapter({ kind, command: "fixture", cwd: "/tmp" }) as any;
    let mode: "model" | "effort" | null = null;
    let pending: "model" | "effort" | null = null;
    let model = 0, effort = 1, cursor = 0;
    const writes: string[] = [];
    const draw = () => adapter.handleData("\u001b[2J\u001b[H" + (mode === "model"
      ? `${cursor === 0 ? "❯" : " "}1. Default${model === 0 ? " ✔" : ""}\r\n${cursor === 1 ? "❯" : " "}2. Sonnet${model === 1 ? " ✔" : ""}\r\nEnter to set as default · s to use this session only`
      : mode === "effort" ? " ".repeat(cursor * 10) + "▲\r\nlow       medium    high\r\ns for this session only" : "❯ "));
    adapter.pty = { write: (text: string) => {
      writes.push(text);
      if (text.includes("/model")) pending = "model";
      else if (text.includes("/effort")) pending = "effort";
      else if (text === "\r" && pending) { mode = pending; pending = null; cursor = mode === "model" ? model : effort; draw(); }
      else if (text === "\u001b") { mode = null; draw(); }
      else if (/\[B|\[C/.test(text)) { cursor++; draw(); }
      else if (/\[A|\[D/.test(text)) { cursor--; draw(); }
      else if (text === "s") { if (mode === "model") model = cursor; else effort = cursor; mode = null; draw(); }
    } };
    adapter.renderLocalOutput = () => undefined;
    adapter.cliSessionReady = true; adapter.state.status = "idle"; adapter.state.sharedSessionId = "original";
    expect(await adapter.setSessionModel("original", "sonnet")).toMatchObject({ currentModel: "sonnet" });
    expect(await adapter.setSessionReasoningEffort("original", "low")).toMatchObject({ currentReasoningEffort: "low" });
    expect(writes.filter((text) => text === "s")).toHaveLength(2);
    expect(writes.some((text) => /\/model\s+sonnet|\/effort\s+low/.test(text))).toBe(false);
    await expect(adapter.setSessionModel("another", "default")).rejects.toThrow("请先打开");
    adapter.localEditorDirty = true;
    await expect(adapter.setSessionModel("original", "default")).rejects.toThrow("尚未发送");
    adapter.localEditorDirty = false; adapter.state.sharedSessionId = "next"; model = 0;
    expect(await adapter.getSessionModelState("next")).toMatchObject({ currentModel: "default" });
  }
}, 20_000);
