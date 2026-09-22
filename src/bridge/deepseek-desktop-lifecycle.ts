import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import { writePrivateFileAtomic } from "../utils/private-files.ts";

const execFileAsync = promisify(execFile);

export const DEEPSEEK_DESKTOP_APP_PATH = "/Applications/DSH Desktop.app";
export const DEEPSEEK_DESKTOP_BUNDLE_ID = "ai.deepseek.dsh.desktop";
const DEEPSEEK_DESKTOP_SETTINGS_PATH = path.join(".dsh", "settings.yaml");
const DEFAULT_QUIT_TIMEOUT_MS = 10_000;
const DEEPSEEK_HARNESS_URL_ENV = "WERELAY_DEEPSEEK_HARNESS_URL";

type DeepSeekDesktopRecoveryDependencies = {
  platform: NodeJS.Platform;
  appExists(): boolean;
  isRunning(): Promise<boolean>;
  readSettings(): string;
  writeSettings(text: string): void;
  launch(): Promise<void>;
  restart(): Promise<void>;
};

function normalizeYamlScalar(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/u, "$2");
}

function topLevelBlockEnd(lines: string[], start: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    if (!/^\s/u.test(line)) return index;
  }
  return lines.length;
}

function upsertDesktopSetting(
  lines: string[],
  start: number,
  end: number,
  key: string,
  value: string,
  insertOffset: number,
): { end: number; insertOffset: number } {
  const pattern = new RegExp(`^\\s{2}${key}\\s*:`);
  for (let index = start + 1; index < end; index += 1) {
    if (!pattern.test(lines[index] ?? "")) continue;
    lines[index] = `  ${key}: ${value}`;
    return { end, insertOffset };
  }
  lines.splice(start + insertOffset, 0, `  ${key}: ${value}`);
  return { end: end + 1, insertOffset: insertOffset + 1 };
}

export function enableDeepSeekDesktopLoopbackAccessInYaml(source: string): {
  text: string;
  changed: boolean;
} {
  const normalized = source.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  const start = lines.findIndex((line) => /^dsh-desktop\s*:/u.test(line));
  if (start < 0) {
    const base = normalized.trimEnd();
    const text = [
      ...(base ? [base, ""] : []),
      "dsh-desktop:",
      "  mode: compatibility",
      "  openBrowser: true",
      "  networkExposure: loopback",
      "",
    ].join("\n");
    return { text, changed: text !== normalized };
  }
  if (!/^dsh-desktop\s*:\s*(?:#.*)?$/u.test(lines[start] ?? "")) {
    throw new Error("DSH Desktop 设置格式无法安全修改，请手动启用兼容模式和本机浏览器访问。");
  }

  let end = topLevelBlockEnd(lines, start);
  for (let index = start + 1; index < end; index += 1) {
    const match = (lines[index] ?? "").match(/^\s{2}mode\s*:\s*(.*?)\s*(?:#.*)?$/u);
    if (!match?.[1]) continue;
    if (normalizeYamlScalar(match[1]) !== "compatibility") {
      throw new Error("DSH Desktop 当前不是兼容模式，请先在 DSH Desktop 设置中切换为兼容模式。");
    }
  }

  let insertOffset = 1;
  ({ end, insertOffset } = upsertDesktopSetting(
    lines,
    start,
    end,
    "mode",
    "compatibility",
    insertOffset,
  ));
  ({ end, insertOffset } = upsertDesktopSetting(
    lines,
    start,
    end,
    "openBrowser",
    "true",
    insertOffset,
  ));
  ({ end, insertOffset } = upsertDesktopSetting(
    lines,
    start,
    end,
    "networkExposure",
    "loopback",
    insertOffset,
  ));
  void end;
  void insertOffset;

  const text = lines.join("\n");
  return { text, changed: text !== normalized };
}

function isDeepSeekDesktopProcessRunning(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const output = execFileSync("/bin/ps", ["-axo", "command="], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split(/\r?\n/u).some((line) =>
      line.trim() === `${DEEPSEEK_DESKTOP_APP_PATH}/Contents/MacOS/DSH Desktop`
    );
  } catch {
    return false;
  }
}

async function waitForDeepSeekDesktopToExit(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isDeepSeekDesktopProcessRunning()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isDeepSeekDesktopProcessRunning();
}

async function launchDeepSeekDesktop(): Promise<void> {
  await execFileAsync("/usr/bin/open", ["-b", DEEPSEEK_DESKTOP_BUNDLE_ID]);
}

async function restartDeepSeekDesktop(): Promise<void> {
  try {
    await execFileAsync("/usr/bin/osascript", [
      "-e",
      `tell application id "${DEEPSEEK_DESKTOP_BUNDLE_ID}" to quit`,
    ], {
      timeout: DEFAULT_QUIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch {
    throw new Error("DSH Desktop 无法自动重启，请先处理电脑端尚未保存的内容后重试。");
  }
  if (!await waitForDeepSeekDesktopToExit(DEFAULT_QUIT_TIMEOUT_MS)) {
    throw new Error("DSH Desktop 正在阻止自动重启，请先处理电脑端尚未保存的内容后重试。");
  }
  await launchDeepSeekDesktop();
}

function defaultRecoveryDependencies(): DeepSeekDesktopRecoveryDependencies {
  const settingsPath = path.join(os.homedir(), DEEPSEEK_DESKTOP_SETTINGS_PATH);
  return {
    platform: process.platform,
    appExists: () => fs.existsSync(DEEPSEEK_DESKTOP_APP_PATH),
    isRunning: async () => isDeepSeekDesktopProcessRunning(),
    readSettings: () => fs.existsSync(settingsPath)
      ? fs.readFileSync(settingsPath, "utf8")
      : "",
    writeSettings: (text) => writePrivateFileAtomic(settingsPath, text, { encoding: "utf8" }),
    launch: launchDeepSeekDesktop,
    restart: restartDeepSeekDesktop,
  };
}

/**
 * Whether an error justifies changing DSH Desktop settings and restarting it.
 *
 * Only the protected-host case qualifies: DSH Desktop answers 403 when its
 * loopback browser access is disabled, and enabling `openBrowser` needs a
 * restart to take effect.
 *
 * Transient transport errors (a refused connection, a timeout, a socket that
 * closed because the Desktop was restarting) must NOT be treated as
 * recoverable. Restarting the user's Desktop because one request raced a
 * restart turns a brief blip into a long outage, and the restart outlives the
 * caller's recovery window so the switch fails anyway. Those cases belong to
 * plain retrying.
 */
function isRecoverableDeepSeekDesktopError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP\s*403|unauthorized|\bforbidden\b/iu.test(message);
}

export async function recoverDeepSeekDesktopHarnessAccess(params: {
  error: unknown;
  allowDesktopApplicationLaunch: boolean;
  /** Separate consent for settings repair; switching terminals is not restart consent. */
  allowDesktopApplicationRestart?: boolean;
  dependencies?: DeepSeekDesktopRecoveryDependencies;
}): Promise<boolean> {
  if (!params.allowDesktopApplicationLaunch) {
    return false;
  }
  if (process.env[DEEPSEEK_HARNESS_URL_ENV]?.trim() ||
      process.env.DESKRELAY_DEEPSEEK_HARNESS_URL?.trim()) {
    return false;
  }
  const dependencies = params.dependencies ?? defaultRecoveryDependencies();
  if (dependencies.platform !== "darwin" || !dependencies.appExists()) {
    return false;
  }

  const protectedHost = isRecoverableDeepSeekDesktopError(params.error);
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  const unavailableHost = /ECONNREFUSED|fetch failed|connection refused|timed?\s*out|timeout|连接失败/iu.test(message);
  if (!await dependencies.isRunning()) {
    if (!protectedHost && !unavailableHost) return false;
    // Starting a closed application does not require rewriting its settings.
    await dependencies.launch();
    return true;
  }

  // A stale cookie can also produce 403. Never stop a running owner merely
  // because a user selected its terminal; retry authentication in the client.
  if (!params.allowDesktopApplicationRestart || !protectedHost) return false;
  const updated = enableDeepSeekDesktopLoopbackAccessInYaml(dependencies.readSettings());
  if (!updated.changed) return false;
  dependencies.writeSettings(updated.text);
  await dependencies.restart();
  return true;
}
