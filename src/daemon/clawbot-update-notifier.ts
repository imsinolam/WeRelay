import fs from "node:fs";
import path from "node:path";
import { CHANNEL_DATA_DIR } from "../wechat/channel-config.ts";
import { writePrivateFileAtomic } from "../utils/private-files.ts";
import { compareVersions, getCurrentVersion } from "../utils/version-checker.ts";

type PublishedRelease = { version: string; url: string };
export type ClawbotUpdateState = {
  checkedAt?: number;
  latest?: PublishedRelease;
  notifiedVersion?: string;
};
const RELEASES = "https://github.com/imsinolam/WeRelay/releases/tag/v";
const CHECK_MS = 6 * 60 * 60_000;
const RETRY_MS = 60 * 60_000;
const SEND_RETRY_MS = 15 * 60_000;

// A tag/main commit can exist before release acceptance. Only announce an
// actual published stable Release; never fall back to an unfinished branch.
export async function fetchPublishedRelease(fetchImpl: typeof fetch = globalThis.fetch): Promise<PublishedRelease | null> {
  const response = await fetchImpl("https://api.github.com/repos/imsinolam/WeRelay/releases/latest", {
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: "application/vnd.github+json", "User-Agent": "WeRelay-Update-Notifier" },
  });
  if (!response.ok) return null;
  const data = await response.json() as { tag_name?: unknown; draft?: boolean; prerelease?: boolean };
  if (!data || data.draft || data.prerelease || typeof data.tag_name !== "string") return null;
  const version = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(data.tag_name)
    ? data.tag_name.replace(/^v/, "") : null;
  return version ? { version, url: `${RELEASES}${version}` } : null;
}

export class ClawbotUpdateNotifier {
  private running = false;
  private stopped = false;
  private inboundPending = false;
  private retryAt = 0;
  private sendRetryAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly options: {
    currentVersion: string;
    read: () => ClawbotUpdateState;
    write: (state: ClawbotUpdateState) => void;
    send: (text: string) => Promise<boolean>;
    fetchRelease?: () => Promise<PublishedRelease | null>;
    now?: () => number;
  }) {}

  start(): void {
    if (this.timer || this.stopped) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, 60_000);
    this.timer.unref?.();
  }
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }
  async tick(options: { inbound?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      if (options.inbound) this.inboundPending = true;
      return;
    }
    this.running = true;
    try {
      const now = this.options.now?.() ?? Date.now();
      let state = this.options.read();
      const age = state.checkedAt === undefined ? Infinity : now - state.checkedAt;
      if ((age < 0 || age >= CHECK_MS) && now >= this.retryAt) {
        this.retryAt = now + RETRY_MS;
        const latest = await (this.options.fetchRelease ?? fetchPublishedRelease)();
        if (this.stopped) return;
        if (latest) {
          state = { ...state, checkedAt: now, latest };
          this.options.write(state);
          this.retryAt = 0;
        }
      }
      const latest = state.latest;
      const current = this.options.currentVersion;
      const stableCurrent = /^(\d+\.\d+\.\d+)/.exec(current)?.[1];
      if (this.stopped || !latest || !stableCurrent ||
        !/^\d+\.\d+\.\d+$/.test(latest.version) ||
        latest.url !== `${RELEASES}${latest.version}` ||
        state.notifiedVersion === latest.version ||
        (compareVersions(latest.version, stableCurrent) <= 0 &&
          !(latest.version === stableCurrent && current.includes("-"))) ||
        (!options.inbound && now < this.sendRetryAt)) return;
      this.sendRetryAt = now + SEND_RETRY_MS;
      const sent = await this.options.send([
        "WeRelay 有新版本可用", `当前运行：${current}`, `GitHub 最新版：${latest.version}`,
        "不会自动安装或重启；你可以先查看更新说明，再决定何时更新。", latest.url,
      ].join("\n"));
      if (sent) this.options.write({ ...state, notifiedVersion: latest.version });
    } catch {
      // Network, WeChat and storage failures never block input or consume a receipt.
    } finally {
      this.running = false;
      if (this.inboundPending && !this.stopped) {
        this.inboundPending = false;
        await this.tick({ inbound: true });
      }
    }
  }
}

export async function createClawbotUpdateNotifier(options: {
  send: (text: string) => Promise<boolean>;
  stateFile?: string;
}): Promise<ClawbotUpdateNotifier> {
  const file = options.stateFile ?? path.join(CHANNEL_DATA_DIR, "clawbot-update-notification.json");
  return new ClawbotUpdateNotifier({
    currentVersion: await getCurrentVersion(),
    send: options.send,
    read: () => {
      try { return JSON.parse(fs.readFileSync(file, "utf8")) as ClawbotUpdateState; }
      catch { return {}; }
    },
    write: (state) => writePrivateFileAtomic(file, JSON.stringify(state, null, 2)),
  });
}
