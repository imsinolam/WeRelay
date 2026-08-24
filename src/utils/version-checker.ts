import fs from "node:fs";
import path from "node:path";
import { CHANNEL_DATA_DIR, ensureChannelDataDir } from "../wechat/channel-config.ts";
import { writePrivateFileAtomic } from "./private-files.ts";

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

// GitHub 是唯一公开版本来源。优先使用正式 Release，其次兼容 tag；
// 当前仓库尚未创建 Release/tag 时，再读取 main 分支的 package.json。
const DEFAULT_GITHUB_RELEASE_URL =
  "https://api.github.com/repos/imsinolam/WeRelay/releases/latest";
const DEFAULT_GITHUB_TAGS_URL =
  "https://api.github.com/repos/imsinolam/WeRelay/tags?per_page=20";
const DEFAULT_GITHUB_PACKAGE_URL =
  "https://raw.githubusercontent.com/imsinolam/WeRelay/main/package.json";
const FETCH_TIMEOUT_MS = 10_000;

export interface FetchLatestVersionOptions {
  /** 自定义 fetch 实现，测试时注入 mock。默认使用全局 fetch。 */
  fetchImpl?: typeof fetch;
  githubReleaseUrl?: string;
  githubTagsUrl?: string;
  githubPackageUrl?: string;
  timeoutMs?: number;
}

type FetchDeps = {
  fetch: typeof fetch;
  githubReleaseUrl: string;
  githubTagsUrl: string;
  githubPackageUrl: string;
  timeoutMs: number;
};

function resolveFetchDeps(options: FetchLatestVersionOptions): FetchDeps {
  return {
    fetch: options.fetchImpl ?? globalThis.fetch,
    githubReleaseUrl: options.githubReleaseUrl ?? DEFAULT_GITHUB_RELEASE_URL,
    githubTagsUrl: options.githubTagsUrl ?? DEFAULT_GITHUB_TAGS_URL,
    githubPackageUrl: options.githubPackageUrl ?? DEFAULT_GITHUB_PACKAGE_URL,
    timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
  };
}

async function fetchJsonWithTimeout(
  url: string,
  deps: FetchDeps,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await deps.fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json, application/json",
        "User-Agent": "WeRelay-Version-Checker",
      },
    });
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch {
    // 网络、超时或解析失败都视为该 GitHub 入口不可用，交由下一入口回退。
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchVersionFromGithubRelease(
  deps: FetchDeps,
): Promise<string | null> {
  const data = await fetchJsonWithTimeout(deps.githubReleaseUrl, deps);
  if (!data || typeof data !== "object") {
    return null;
  }
  return parseVersion((data as { tag_name?: unknown }).tag_name);
}

async function fetchVersionFromGithubTags(
  deps: FetchDeps,
): Promise<string | null> {
  const data = await fetchJsonWithTimeout(deps.githubTagsUrl, deps);
  if (!Array.isArray(data)) {
    return null;
  }
  const versions = data
    .map((tag) => parseVersion((tag as { name?: unknown }).name))
    .filter((version): version is string => version !== null)
    .sort((a, b) => compareVersions(b, a));
  return versions[0] ?? null;
}

async function fetchVersionFromGithubPackage(
  deps: FetchDeps,
): Promise<string | null> {
  const data = await fetchJsonWithTimeout(deps.githubPackageUrl, deps);
  if (!data || typeof data !== "object") {
    return null;
  }
  return parseVersion((data as { version?: unknown }).version);
}

/**
 * 从 GitHub 获取最新公开版本号。
 * 通过 HTTPS 请求而非本地 git 命令，因此对全局安装的 werelay-check-update 同样可用。
 */
export async function fetchLatestVersion(
  options: FetchLatestVersionOptions = {},
): Promise<string | null> {
  const deps = resolveFetchDeps(options);
  return (
    (await fetchVersionFromGithubRelease(deps)) ??
    (await fetchVersionFromGithubTags(deps)) ??
    (await fetchVersionFromGithubPackage(deps))
  );
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

const VERSION_PATTERN = /(\d+\.\d+\.\d+)/;

/**
 * 从任意字符串中提取版本号,兼容带 "v" 前缀的 tag(如 "v1.1.1")。
 */
export function parseVersion(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const match = VERSION_PATTERN.exec(raw.trim());
  return match ? (match[1] ?? null) : null;
}

/**
 * 比较两个版本号
 * @returns 返回值 > 0 表示 version1 更新，< 0 表示 version2 更新，= 0 表示相等
 */
export function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;

    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }

  return 0;
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
   Pull the latest GitHub source, run npm ci,
   then install the local tarball produced by npm pack.

For more information:
   https://github.com/imsinolam/WeRelay
`;
}
