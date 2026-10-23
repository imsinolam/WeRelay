import { expect, test } from "bun:test";
import { ClawbotUpdateController, parseClawbotUpdateCommand } from "../../src/daemon/clawbot-update-controller.ts";
const latest = { version: "0.3.21-preview.10", tagName: "v0.3.21-preview.10", prerelease: true,
  url: "https://github.com/imsinolam/WeRelay/releases/tag/v0.3.21-preview.10" };
function fixture() {
  const messages: string[] = []; let installs = 0;
  const options = {
    send: async (text: string) => { messages.push(text); return true; },
    getVersion: async () => "0.3.20", fetchRelease: async () => latest,
    resolveInstallPath: async () => "/test/prefix/lib/node_modules/werelay",
    upgrade: async () => { installs++; return { status: "upgraded" as const, from: "0.3.20", to: latest.version,
      installPath: "/test/prefix/lib/node_modules/werelay", backupPath: "/test/backup" }; },
  };
  return { messages, options, installs: () => installs };
}
test("whole-word explicit update only; normal agent tasks remain tasks", () => {
  expect(parseClawbotUpdateCommand("更新")).toBe("install");
  expect(parseClawbotUpdateCommand(" /UPDATE ")).toBe("install");
  expect(parseClawbotUpdateCommand("检查更新")).toBe("check");
  for (const text of ["更新一下网页", "发布新版本", "任务3：更新", "重启应用"]) expect(parseClawbotUpdateCommand(text)).toBeNull();
});
test("checking reports prereleases with final link but never installs", async () => {
  const f = fixture(); const controller = new ClawbotUpdateController(f.options);
  expect(controller.handle("检查更新")).toBe(true); await controller.waitForIdle();
  expect(f.installs()).toBe(0); expect(f.messages.at(-1)).toContain("预发布");
  expect(f.messages.at(-1)?.endsWith(latest.url)).toBe(true);
});
test("explicit consent installs preview once, duplicate request cannot start another job", async () => {
  const f = fixture(); const controller = new ClawbotUpdateController(f.options);
  expect(controller.handle("更新")).toBe(true);
  expect(controller.handle("更新")).toBe(true);
  await controller.waitForIdle(); expect(f.installs()).toBe(1);
  expect(f.messages.some((m) => m.includes("正在") && m.includes("更新"))).toBe(true);
  expect(f.messages.at(-1)).toContain("尚未重启");
});
test("update is background work and never blocks the caller or ordinary inbound messages", async () => {
  const f = fixture(); let unblock!: () => void;
  const gate = new Promise<void>((r) => { unblock = r; });
  const controller = new ClawbotUpdateController({ ...f.options, fetchRelease: async () => { await gate; return latest; } });
  expect(controller.handle("更新")).toBe(true);
  expect(controller.handle("任务")).toBe(false);
  expect(f.installs()).toBe(0); unblock(); await controller.waitForIdle(); expect(f.installs()).toBe(1);
});
test("equal/newer local versions and failed lookups never install", async () => {
  for (const override of [{ getVersion: async () => latest.version }, { getVersion: async () => "0.3.22" },
    { fetchRelease: async () => null }, { resolveInstallPath: async () => null }]) {
    const f = fixture(); const c = new ClawbotUpdateController({ ...f.options, ...override });
    c.handle("更新"); await c.waitForIdle(); expect(f.installs()).toBe(0); expect(f.messages.length).toBeGreaterThan(0);
  }
});
test("stopping before the download completes prevents a subsequent global install", async () => {
  const f = fixture(); let unblock!: () => void; const gate = new Promise<void>((r) => { unblock = r; });
  const c = new ClawbotUpdateController({ ...f.options, fetchRelease: async () => { await gate; return latest; } });
  c.handle("更新"); c.stop(); unblock(); await c.waitForIdle(); expect(f.installs()).toBe(0);
});

test("update lookup failure and failed feedback cannot install", async () => {
  const f = fixture();
  const controller = new ClawbotUpdateController({ ...f.options, fetchRelease: async () => { throw new Error("offline"); } });
  controller.handle("更新"); await controller.waitForIdle(); expect(f.installs()).toBe(0);
  expect(f.messages.at(-1)).toContain("未完成");
  const g = fixture(); const silent = new ClawbotUpdateController({ ...g.options, send: async () => false });
  silent.handle("更新"); await silent.waitForIdle(); expect(g.installs()).toBe(0);
});

test("restart requires its own explicit request, known supervisor and delivered acknowledgement", async () => {
  const f = fixture(); let restarts = 0;
  const controller = new ClawbotUpdateController({ ...f.options, restart: () => { restarts++; }, canRestart: () => true });
  controller.handle("更新"); await controller.waitForIdle(); expect(restarts).toBe(0);
  controller.handle("重启"); await controller.waitForIdle(); expect(restarts).toBe(1);
  const manual = new ClawbotUpdateController({ ...f.options, restart: () => { restarts++; }, canRestart: () => false });
  manual.handle("重启"); await manual.waitForIdle(); expect(restarts).toBe(1);
  const silent = new ClawbotUpdateController({ ...f.options, restart: () => { restarts++; }, canRestart: () => true, send: async () => false });
  silent.handle("重启"); await silent.waitForIdle(); expect(restarts).toBe(1);
});

test("daemon connects the controller behind sender authorization and before adapter routing", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../../src/daemon/werelay-daemon.ts", import.meta.url), "utf8");
  const start = source.indexOf("  private async handleInboundMessage(");
  const body = source.slice(start);
  const handler = body.indexOf("this.updateController?.handle(message.text)");
  expect(handler).toBeGreaterThan(body.indexOf("message.senderId !== this.authorizedUserId"));
  expect(handler).toBeLessThan(body.indexOf("const switchCommand = parseDaemonSwitchCommand(message.text)"));
  expect(body).not.toContain("await this.updateController.handle");
  expect(source).toContain("this.updateController?.stop()");
  expect(source).toContain("await this.updateController?.waitForIdle()");
});


test("restart verifies live launchd PID and unconditional keepalive, not just a label", async () => {
  const { canRestartClawbotService } = await import("../../src/daemon/clawbot-update-restart.ts");
  const options = { platform: "darwin" as const, env: { XPC_SERVICE_NAME: "com.sinolin.werelay-daemon" }, uid: 501, pid: 123,
    inspect: async () => "pid = 123\nproperties = keepalive | runatload\n" };
  expect(await canRestartClawbotService(options)).toBe(true);
  expect(await canRestartClawbotService({ ...options, pid: 124 })).toBe(false);
  expect(await canRestartClawbotService({ ...options, inspect: async () => "pid = 123\nproperties = runatload\n" })).toBe(false);
  expect(await canRestartClawbotService({ ...options, platform: "win32" })).toBe(false);
  expect(await canRestartClawbotService({ ...options, env: { XPC_SERVICE_NAME: "unrelated-service" } })).toBe(false);
  expect(await canRestartClawbotService({ ...options, inspect: async () => { throw new Error("not loaded"); } })).toBe(false);
});
