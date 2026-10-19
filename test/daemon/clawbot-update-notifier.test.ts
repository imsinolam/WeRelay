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
  test("只认可本仓库正式 Release，不以 main/tag/prerelease 误报", async () => {
    for (const data of [
      { tag_name: "v0.3.17", draft: true },
      { tag_name: "v0.3.17", prerelease: true },
      { tag_name: "v0.3.17-preview.1" },
      { tag_name: "anything0.3.17" },
    ]) {
      const result = await fetchPublishedRelease((async () => Response.json(data)) as typeof fetch);
      expect(result).toBeNull();
    }
    const result = await fetchPublishedRelease((async () => Response.json({ tag_name: "v0.3.17", html_url: "https://evil.example" })) as typeof fetch);
    expect(result).toEqual(release);
  });
  test("六小时后发现下一个版本仍提醒，旧版缓存不掩盖新发布", async () => {
    const f = fixture(); let latest = release;
    const n = new ClawbotUpdateNotifier({ ...f.options, fetchRelease: async () => latest });
    await n.tick(); latest = { version: "0.3.18", url: release.url.replace("17", "18") };
    f.time(1_000_000 + 6 * 60 * 60_000); await n.tick();
    expect(f.messages).toHaveLength(2); expect(f.messages[1]).toContain("0.3.18");
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
