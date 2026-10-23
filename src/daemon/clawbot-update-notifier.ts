import fs from "node:fs";
import path from "node:path";
import { CHANNEL_DATA_DIR } from "../wechat/channel-config.ts";
import { writePrivateFileAtomic } from "../utils/private-files.ts";
import { compareVersions, getCurrentVersion, parseVersion } from "../utils/version-checker.ts";
import { fetchLatestPublishedRelease, validatePublishedRelease, type PublishedRelease } from "../utils/github-release.ts";

type CachedRelease = { version: string; url: string; tagName?: string; prerelease?: boolean };
export const CLAWBOT_UPDATE_POLICY = 2;
export type ClawbotUpdateState = {
  checkedAt?: number;
  latest?: CachedRelease;
  notifiedVersion?: string;
  notifiedAt?: number;
  policyVersion?: number;
};
const CHECK_MS = 24 * 60 * 60_000;
const RETRY_MS = 60 * 60_000;
const SEND_RETRY_MS = 15 * 60_000;

export async function fetchPublishedRelease(fetchImpl: typeof fetch = globalThis.fetch): Promise<PublishedRelease | null> {
  return fetchLatestPublishedRelease({ fetchImpl });
}

export class ClawbotUpdateNotifier {
  private running = false;
  private stopped = false;
  private inboundPending = false;
  private retryAt = 0;
  private sendRetryAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly options: {
    currentVersion: string | (() => Promise<string>);
    read: () => ClawbotUpdateState;
    write: (state: ClawbotUpdateState) => void;
    send: (text: string) => Promise<boolean>;
    fetchRelease?: () => Promise<CachedRelease | null>;
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
      if ((state.policyVersion !== CLAWBOT_UPDATE_POLICY || age < 0 || age >= CHECK_MS) && now >= this.retryAt) {
        this.retryAt = now + RETRY_MS;
        const latest = validatePublishedRelease(await (this.options.fetchRelease ?? fetchPublishedRelease)());
        if (this.stopped) return;
        if (latest) {
          state = { ...state, checkedAt: now, latest, policyVersion: CLAWBOT_UPDATE_POLICY };
          this.options.write(state);
          this.retryAt = 0;
        }
      }
      const latest = validatePublishedRelease(state.latest);
      const current = typeof this.options.currentVersion === "function"
        ? await this.options.currentVersion() : this.options.currentVersion;
      const notifiedAge = state.notifiedAt === undefined ? Infinity : now - state.notifiedAt;
      if (this.stopped || !latest || !parseVersion(current) ||
        state.notifiedVersion === latest.version ||
        (notifiedAge >= 0 && notifiedAge < CHECK_MS) ||
        compareVersions(latest.version, current) <= 0 ||
        (!options.inbound && now < this.sendRetryAt)) return;
      this.sendRetryAt = now + SEND_RETRY_MS;
      const sent = await this.options.send([
        "WeRelay 有新版本可用", `当前安装：${current}`,
        `GitHub 最新发布：${latest.version}${latest.prerelease ? "（预发布）" : ""}`,
        "回复“更新”自动下载并安装。未经同意不会自动安装，安装后不会自行重启。", latest.url,
      ].join("\n"));
      if (sent) this.options.write({ ...state, notifiedVersion: latest.version, notifiedAt: now });
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
    currentVersion: getCurrentVersion,
    send: options.send,
    read: () => {
      try { return JSON.parse(fs.readFileSync(file, "utf8")) as ClawbotUpdateState; }
      catch { return {}; }
    },
    write: (state) => writePrivateFileAtomic(file, JSON.stringify(state, null, 2)),
  });
}
