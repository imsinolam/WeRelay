import { expect, test } from "bun:test";
import { classifyDeepSeekDesktopProcess } from "../../src/bridge/deepseek-desktop-process.ts";
import { detectOpenMobileAdaptersFromProcessList } from "../../src/daemon/werelay-daemon.ts";

test("new and legacy Desktop processes belong to the same DeepSeek adapter", () => {
  const main = "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness";
  const host = `${main} --expose-internals /Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js /runtime`;
  expect(classifyDeepSeekDesktopProcess(main)).toBe("main");
  expect(classifyDeepSeekDesktopProcess(host)).toBe("host");
  expect(classifyDeepSeekDesktopProcess("/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop")).toBe("legacy");
  expect(classifyDeepSeekDesktopProcess(`/usr/bin/echo ${main}`)).toBeNull();
  expect(classifyDeepSeekDesktopProcess(`${main} --expose-internals /other/server.js`)).toBeNull();
  expect(classifyDeepSeekDesktopProcess(`${host.replace("index.js", "index.js.fake")}`)).toBeNull();
  expect(detectOpenMobileAdaptersFromProcessList(` 21 ${host}\n`)).toContain("deepseek");
  expect(detectOpenMobileAdaptersFromProcessList(main)).toContain("deepseek");
  expect(detectOpenMobileAdaptersFromProcessList(`/usr/bin/echo ${main}`).has("deepseek")).toBe(false);
});
