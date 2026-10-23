import { describe, expect, test } from "bun:test";
import { ClawbotUpdateNotifier, type ClawbotUpdateState, fetchPublishedRelease } from "../../src/daemon/clawbot-update-notifier.ts";

const release = { version: "0.3.17", url: "https://github.com/imsinolam/WeRelay/releases/tag/v0.3.17" };
function fixture(initial: ClawbotUpdateState = {}) {
  let state = initial;
  let now = 1_000_000;
  let available = true;
  let fetches = 0;
  const messages: string[] = [];
  const options = {
    currentVersion: "0.3.16", now: () => now,
    read: () => state, write: (next: ClawbotUpdateState) => { state = { ...next }; },
    fetchRelease: async () => { fetches++; return release; },
    send: async (text: string) => { messages.push(text); return available; },
  };
  return { options, messages, state: () => state, fetches: () => fetches,
    time: (value: number) => { now = value; }, available: (value: boolean) => { available = value; } };
}

describe("ClawBot GitHub 更新提醒", () => {
  test("旧运行版发现新正式 Release，中文提示但不安装；重启不重复", async () => {
    const f = fixture();
    await new ClawbotUpdateNotifier(f.options).tick();
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]).toContain("0.3.16");
    expect(f.messages[0]).toContain("0.3.17");
    expect(f.messages[0]).toContain("不会自动安装");
    expect(f.messages[0]).toContain(release.url);
    await new ClawbotUpdateNotifier(f.options).tick();
    expect(f.messages).toHaveLength(1);
    expect(f.fetches()).toBe(1);
  });
  test("微信发送失败不标记送达；新入站可立即重试且不重复查询 GitHub", async () => {
    const f = fixture(); f.available(false);
    const notifier = new ClawbotUpdateNotifier(f.options);
    await notifier.tick();
    expect(f.state().notifiedVersion).toBeUndefined();
    await notifier.tick();
    expect(f.messages).toHaveLength(1);
    f.available(true);
    await notifier.tick({ inbound: true });
    expect(f.messages).toHaveLength(2);
    expect(f.state().notifiedVersion).toBe("0.3.17");
    expect(f.fetches()).toBe(1);
  });
  test("已是新版或比公开版更新时不通知；预览同编号可提醒正式版", async () => {
    for (const currentVersion of ["0.3.17", "0.3.18"]) {
      const f = fixture();
      await new ClawbotUpdateNotifier({ ...f.options, currentVersion }).tick();
      expect(f.messages).toHaveLength(0);
    }
    const f = fixture();
    await new ClawbotUpdateNotifier({ ...f.options, currentVersion: "0.3.17-preview.20261019.1" }).tick();
    expect(f.messages).toHaveLength(1);
  });
  test("查询失败不吞掉下一次检查、不发送假更新", async () => {
    const f = fixture();
    let calls = 0;
    const n = new ClawbotUpdateNotifier({ ...f.options, fetchRelease: async () => {
      if (++calls === 1) throw new Error("network");
      return release;
    } });
    await n.tick(); expect(f.messages).toHaveLength(0);
    f.time(1_000_000 + 60 * 60_000);
    await n.tick(); expect(f.messages).toHaveLength(1);
  });
  test("并发检查只发送一次；关闭后不再发送", async () => {
    const f = fixture(); const n = new ClawbotUpdateNotifier(f.options);
    await Promise.all([n.tick(), n.tick({ inbound: true }), n.tick()]);
    expect(f.messages).toHaveLength(1);
    const g = fixture(); const stopped = new ClawbotUpdateNotifier(g.options);
    stopped.stop(); await stopped.tick(); expect(g.messages).toHaveLength(0);
  });
  test("只认可已发布 Release，包含预发布但排除草稿和不合法版本", async () => {
    for (const data of [
      { tag_name: "v0.3.17", draft: true },
      { tag_name: "anything0.3.17" },
    ]) {
      const result = await fetchPublishedRelease((async () => Response.json([data])) as typeof fetch);
      expect(result).toBeNull();
    }
    const result = await fetchPublishedRelease((async () => Response.json([{ tag_name: "v0.3.17", html_url: "https://evil.example" }])) as typeof fetch);
    expect(result).toMatchObject(release);
  });
  test("每日检查新发布，旧版缓存不掩盖更新", async () => {
    const f = fixture(); let latest = release;
    const n = new ClawbotUpdateNotifier({ ...f.options, fetchRelease: async () => latest });
    await n.tick(); latest = { version: "0.3.18", url: release.url.replace("17", "18") };
    f.time(1_000_000 + 24 * 60 * 60_000); await n.tick();
    expect(f.messages).toHaveLength(2); expect(f.messages[1]).toContain("0.3.18");
  });

  test("已发布预览版也提示并可回复更新，同编号比较完整尾号", async () => {
    const f = fixture();
    const latest = { version: "0.3.21-preview.10", url: "https://github.com/imsinolam/WeRelay/releases/tag/v0.3.21-preview.10" };
    await new ClawbotUpdateNotifier({ ...f.options, currentVersion: "0.3.21-preview.2", fetchRelease: async () => latest }).tick();
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]).toContain(latest.version);
    expect(f.messages[0]).toContain("预发布");
    expect(f.messages[0]).toContain("回复“更新”");
    expect(f.messages[0]?.endsWith(latest.url)).toBe(true);
    for (const currentVersion of [latest.version, "0.3.21", "0.3.22-preview.1"]) {
      const g = fixture();
      await new ClawbotUpdateNotifier({ ...g.options, currentVersion, fetchRelease: async () => latest }).tick();
      expect(g.messages).toEqual([]);
    }
  });

  test("升级策略变更后刷新旧正式版缓存，但不会在当天重复提醒", async () => {
    const f = fixture({ checkedAt: 1_000_000, latest: release, notifiedVersion: release.version });
    const latest = { version: "0.3.21-preview.1", url: "https://github.com/imsinolam/WeRelay/releases/tag/v0.3.21-preview.1" };
    const notifier = new ClawbotUpdateNotifier({ ...f.options, fetchRelease: async () => latest });
    await notifier.tick();
    expect(f.messages[0]).toContain(latest.version);
    await notifier.tick({ inbound: true });
    expect(f.messages).toHaveLength(1);
  });
});

test("daemon lifecycle connects background checks, inbound retry and shutdown without blocking polls", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../../src/daemon/werelay-daemon.ts", import.meta.url), "utf8");
  expect(source).toContain("this.updateNotifier.start()");
  expect(source).toContain("void this.updateNotifier?.tick({ inbound: true })");
  expect(source).toContain("this.updateNotifier?.stop()");
  expect(source).not.toContain("await this.updateNotifier.tick");
});

test("new inbound during an in-flight rejection requests one recovery pass", async () => {
  const f = fixture();
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let sends = 0;
  const n = new ClawbotUpdateNotifier({ ...f.options, send: async () => {
    if (++sends === 1) { await first; return false; }
    return true;
  } });
  const running = n.tick();
  while (!sends) await new Promise((resolve) => setTimeout(resolve, 1));
  await n.tick({ inbound: true });
  releaseFirst(); await running;
  expect(sends).toBe(2);
  expect(f.state().notifiedVersion).toBe("0.3.17");
});

test("24小时内不重复查，错过检查后在下次启动顺延", async () => {
  const f = fixture();
  const n = new ClawbotUpdateNotifier(f.options); await n.tick();
  f.time(1_000_000 + 23 * 60 * 60_000); await n.tick({ inbound: true });
  expect(f.fetches()).toBe(1);
  f.time(1_000_000 + 50 * 60 * 60_000); await new ClawbotUpdateNotifier(f.options).tick();
  expect(f.fetches()).toBe(2); expect(f.messages).toHaveLength(1);
});

test("策略迁移发现更新也遵守一天最多一次成功提醒", async () => {
  const f = fixture({ policyVersion: 1, notifiedAt: 1_000_000, notifiedVersion: release.version });
  const latest = { version: "0.3.21-rc.1", url: "https://github.com/imsinolam/WeRelay/releases/tag/v0.3.21-rc.1" };
  const n = new ClawbotUpdateNotifier({ ...f.options, fetchRelease: async () => latest });
  await n.tick({ inbound: true }); expect(f.fetches()).toBe(0); expect(f.messages).toHaveLength(0);
  f.time(1_000_000 + 24 * 60 * 60_000); await n.tick(); expect(f.messages).toHaveLength(1);
});

test("安装后延迟读取当前版本，不拿启动时的旧版本反复提醒", async () => {
  const f = fixture(); let current = "0.3.16";
  f.available(false);
  const n = new ClawbotUpdateNotifier({ ...f.options, currentVersion: async () => current });
  await n.tick(); expect(f.messages).toHaveLength(1);
  current = release.version; f.available(true); await n.tick({ inbound: true });
  expect(f.messages).toHaveLength(1); expect(f.state().notifiedVersion).toBeUndefined();
});

test("篡改的缓存链接不推送，陈旧正式版缓存刷新失败不误报已是最新", async () => {
  const f = fixture({ policyVersion: 2, checkedAt: 1_000_000,
    latest: { version: "99.0.0", url: "https://evil.example/releases/tag/v99.0.0" } });
  await new ClawbotUpdateNotifier(f.options).tick(); expect(f.messages).toHaveLength(0);
});
