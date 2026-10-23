import fs from "node:fs";
import path from "node:path";
import { CHANNEL_DATA_DIR, ensureChannelDataDir } from "../wechat/channel-config.ts";
import { writePrivateFileAtomic } from "./private-files.ts";
import { fetchLatestPublishedRelease } from "./github-release.ts";
import { compareVersions } from "./semver.ts";
export { compareVersions, parseVersion } from "./semver.ts";

const UPDATE_CHECK_FILE = path.join(CHANNEL_DATA_DIR, "update-check.json");
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24小时

export interface UpdateCheckCache {
  lastCheck: string;
  lastNotifiedVersion: string;
}

export interface VersionInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
}

// CLI and ClawBot share the same published Release policy, including previews.
export interface FetchLatestVersionOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function fetchLatestVersion(
  options: FetchLatestVersionOptions = {},
): Promise<string | null> {
  return (await fetchLatestPublishedRelease(options))?.version ?? null;
}

/**
 * 从本地 package.json 读取当前版本
 */
export async function getCurrentVersion(): Promise<string> {
  const packageJsonPath = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "package.json"
  );

  try {
    const content = await fs.promises.readFile(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(content);
    return packageJson.version || "0.0.0";
  } catch (error) {
    return "0.0.0";
  }
}

/**
 * 读取更新检查缓存
 */
function readUpdateCache(): UpdateCheckCache | null {
  try {
    if (!fs.existsSync(UPDATE_CHECK_FILE)) {
      return null;
    }

    const content = fs.readFileSync(UPDATE_CHECK_FILE, "utf-8");
    return JSON.parse(content) as UpdateCheckCache;
  } catch (error) {
    return null;
  }
}

/**
 * 写入更新检查缓存
 */
function writeUpdateCache(cache: UpdateCheckCache): void {
  try {
    ensureChannelDataDir();
    writePrivateFileAtomic(UPDATE_CHECK_FILE, JSON.stringify(cache, null, 2));
  } catch (error) {
    // 静默失败，不影响正常使用
  }
}

/**
 * 检查是否有新版本可用
 * @param forceCheck 是否强制检查（忽略缓存）
 */
export async function checkForUpdate(
  forceCheck = false
): Promise<VersionInfo | null> {
  const currentVersion = await getCurrentVersion();

  // 检查缓存
  if (!forceCheck) {
    const cache = readUpdateCache();
    if (cache) {
      const lastCheckTime = new Date(cache.lastCheck).getTime();
      const now = Date.now();

      // 如果缓存未过期（24小时内），且已经通知过最新版本
      if (now - lastCheckTime < CACHE_DURATION_MS) {
        // 如果缓存的版本与当前版本一致，说明已经通知过
        if (cache.lastNotifiedVersion === currentVersion) {
          return null;
        }
      }
    }
  }

  // 从 GitHub 获取最新版本
  const latestVersion = await fetchLatestVersion();
  if (!latestVersion) {
    return null;
  }

  // 比较版本
  const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

  // 更新缓存
  writeUpdateCache({
    lastCheck: new Date().toISOString(),
    lastNotifiedVersion: currentVersion,
  });

  return {
    current: currentVersion,
    latest: latestVersion,
    hasUpdate,
  };
}

/**
 * 格式化更新提示信息
 */
export function formatUpdateMessage(versionInfo: VersionInfo): string {
  const { current, latest } = versionInfo;

  return `
[Update Available] Version ${latest} is available (current: ${current})

Update instructions:
   Reply 更新 in ClawBot, or download the published release tag's source, run npm ci,
   then install the local tarball produced by npm pack.

For more information:
   https://github.com/imsinolam/WeRelay
`;
}
