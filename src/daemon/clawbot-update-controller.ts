import { getCurrentVersion } from "../utils/version-checker.ts";
import { compareVersions, parseVersion } from "../utils/semver.ts";
import { fetchLatestPublishedRelease, validatePublishedRelease, type PublishedRelease } from "../utils/github-release.ts";
import { formatUpgradeResultMessage, resolveGlobalInstallPath, runWeRelayUpgrade } from "./clawbot-upgrade.ts";

export function parseClawbotUpdateCommand(text: string): "check" | "install" | "restart" | null {
  const value = text.trim();
  if (/^检查更新$/u.test(value)) return "check";
  if (/^(?:更新|升级|更新版本|升级版本|\/update)$/iu.test(value)) return "install";
  if (/^(?:重启|重启守护进程|重启服务|\/restart)$/iu.test(value)) return "restart";
  return null;
}

export class ClawbotUpdateController {
  private job?: Promise<void>;
  private stopped = false;
  private readonly abort = new AbortController();
  constructor(private readonly options: {
    send: (text: string) => Promise<boolean>;
    getVersion?: () => Promise<string>;
    fetchRelease?: () => Promise<PublishedRelease | null>;
    resolveInstallPath?: () => Promise<string | null>;
    upgrade?: typeof runWeRelayUpgrade;
    canRestart?: () => boolean | Promise<boolean>;
    restart?: () => void;
    log?: (event: string) => void;
  }) {}

  /** Claim synchronously; never await downloads/builds in the inbound poll loop. */
  handle(text: string): boolean {
    const command = parseClawbotUpdateCommand(text);
    if (!command) return false;
    if (this.stopped) return true;
    if (this.job) {
      void this.options.send("正在检查或更新 WeRelay，完成后会通知你，请勿重复提交。").catch(() => {});
      return true;
    }
    this.job = this.run(command).catch(async () => {
      this.options.log?.("clawbot_upgrade_error");
      await this.options.send("WeRelay 更新未完成，请稍后重试；可在电脑检查安装状态。").catch(() => {});
    }).finally(() => { this.job = undefined; });
    return true;
  }

  stop(): void { this.stopped = true; this.abort.abort(); }
  async waitForIdle(): Promise<void> { await this.job; }

  private async send(text: string): Promise<boolean> {
    return this.stopped ? false : this.options.send(text).catch(() => false);
  }

  private async run(command: "check" | "install" | "restart"): Promise<void> {
    if (command === "restart") {
      if (!this.options.restart || !await this.options.canRestart?.()) {
        await this.send("当前服务未确认有自动保活，未退出以免失去连接。请在电脑重启 WeRelay，让已安装版本生效。");
        return;
      }
      if (await this.send("正在重启 WeRelay，微信和网页会短暂断开，随后由后台服务恢复。")) {
        this.options.log?.("clawbot_restart_requested: source=wechat");
        if (!this.stopped) this.options.restart();
      }
      return;
    }
    // A failed acknowledgement does not consume consent or hide the job from
    // the user: do not replace software when no update feedback can be delivered.
    if (!await this.send("正在检查 WeRelay 已发布版本（包含预发布），不会影响任务消息收发。")) return;
    const current = await (this.options.getVersion ?? getCurrentVersion)();
    const latest = validatePublishedRelease(await (this.options.fetchRelease ?? fetchLatestPublishedRelease)());
    if (this.stopped) return;
    if (!latest || !parseVersion(current)) {
      await this.send("暂时无法从 GitHub 确认已发布版本，未执行更新。请稍后重试。");
      return;
    }
    if (compareVersions(latest.version, current) <= 0) {
      await this.send(`当前安装 ${current}，没有更新的已发布版本（包含预发布）。`);
      return;
    }
    const description = `${latest.version}${latest.prerelease ? "（预发布）" : ""}`;
    if (command === "check") {
      await this.send([`WeRelay 有更新：${description}`, `当前安装：${current}`,
        "回复“更新”自动下载并安装；安装后不会自行重启。", latest.url].join("\n"));
      return;
    }
    const installPath = await (this.options.resolveInstallPath ?? resolveGlobalInstallPath)();
    if (this.stopped) return;
    if (!installPath) {
      await this.send("当前不是可确认的独立全局安装，未替换源码或链接目录。请按 GitHub 安装说明从本地 tarball 更新。");
      return;
    }
    if (!await this.send([`开始更新 WeRelay：${current} → ${description}`,
      "正在后台下载、构建并安装；会保留回退备份，不会自动重启。", latest.url].join("\n"))) return;
    if (this.stopped) return;
    this.options.log?.(`clawbot_upgrade_started: from=${current} to=${latest.version}`);
    const result = await (this.options.upgrade ?? runWeRelayUpgrade)({
      plan: { currentVersion: current, targetVersion: latest.version, tagName: latest.tagName },
      installPath, signal: this.abort.signal,
      onStage: async (stage) => {
        if (stage === "build") await this.send(`正在构建 WeRelay ${latest.version}，完成后会通知你。`);
      },
    });
    this.options.log?.(`clawbot_upgrade_finished: status=${result.status}${result.status === "failed" ? ` stage=${result.stage}` : ""}`);
    await this.send(formatUpgradeResultMessage(result));
  }
}
