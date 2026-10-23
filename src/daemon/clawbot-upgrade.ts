import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildCliEnvironment, resolveSpawnTarget } from "../bridge/bridge-adapters.shared.ts";
import { CHANNEL_DATA_DIR } from "../wechat/channel-config.ts";
import { ensurePrivateDir, writePrivateFileAtomic } from "../utils/private-files.ts";
import { compareVersions, parseVersion } from "../utils/semver.ts";
import { releaseFromTag, WERELAY_GITHUB_REPO } from "../utils/github-release.ts";

export type UpgradePlan = { currentVersion: string; targetVersion: string; tagName: string };
export type UpgradeStage = "download" | "extract" | "build" | "install" | "verify";
export type UpgradeResult =
  | { status: "upgraded"; from: string; to: string; installPath: string; backupPath: string }
  | { status: "failed"; stage: UpgradeStage; detail: string; backupPath?: string; rolledBack?: boolean };
type ExecLike = (file: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;
const execAsync = promisify(execFile);
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export function buildSourceArchiveUrl(tagName: string): string | null {
  return releaseFromTag(tagName)
    ? `https://github.com/${WERELAY_GITHUB_REPO}/archive/refs/tags/${encodeURIComponent(tagName)}.tar.gz` : null;
}

function readPackage(directory: string): { name?: string; version?: string; bin?: unknown } {
  return JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
}

function installPrefix(directory: string): string | null {
  if (!path.isAbsolute(directory) || path.basename(directory) !== "werelay" ||
    path.basename(path.dirname(directory)) !== "node_modules") return null;
  const parent = path.dirname(path.dirname(directory));
  return path.basename(parent) === "lib" ? path.dirname(parent) : process.platform === "win32" ? parent : null;
}

export async function resolveGlobalInstallPath(options: { moduleDir?: string } = {}): Promise<string | null> {
  // A development checkout must never silently update an unrelated global copy.
  const directory = options.moduleDir ?? path.resolve(import.meta.dirname, "..", "..");
  try {
    if (!installPrefix(directory) || fs.lstatSync(directory).isSymbolicLink()) return null;
    return readPackage(directory).name === "werelay" ? directory : null;
  } catch { return null; }
}

function acquireUpdateLock(root: string): () => void {
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error("更新锁目录不安全");
  ensurePrivateDir(root);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("更新锁目录不属于当前用户");
  }
  const file = path.join(root, "install.lock");
  const value = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, value, { flag: "wx", mode: 0o600 });
      return () => {
        try { if (fs.readFileSync(file, "utf8") === value) fs.unlinkSync(file); }
        catch { /* Never remove another updater's lock. */ }
      };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const previous = fs.lstatSync(file);
    if (!previous.isFile() || previous.isSymbolicLink()) throw new Error("已有更新正在进行，未重复安装");
    const { pid } = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number };
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0) throw new Error("无法确认更新锁归属");
    try { process.kill(pid!, 0); throw new Error("已有更新正在进行，未重复安装"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    if (fs.lstatSync(file).ino !== previous.ino) throw new Error("更新锁已变化，请稍后重试");
    fs.unlinkSync(file);
  }
  throw new Error("无法获得更新锁");
}

async function downloadArchive(url: string, target: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(5 * 60_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetchImpl(url, { signal: combined, headers: { "User-Agent": "WeRelay-Upgrader" } });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const advertised = Number(response.headers.get("content-length"));
  if (advertised > MAX_ARCHIVE_BYTES) throw new Error("发布归档过大，已停止更新");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("下载内容为空");
  const file = fs.openSync(target, "wx", 0o600);
  let size = 0;
  try {
    while (true) {
      combined.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_ARCHIVE_BYTES) throw new Error("发布归档过大，已停止更新");
      fs.writeFileSync(file, value);
    }
    if (!size) throw new Error("下载内容为空");
  } finally { await reader.cancel().catch(() => {}); fs.closeSync(file); }
}

function validateArchive(listing: string, types: string): void {
  const entries = listing.trim().split(/\r?\n/);
  if (entries.length > 100_000 || !entries.length) throw new Error("归档目录无效");
  let root: string | undefined;
  for (const entry of entries) {
    if (!entry || /[\\\0]/.test(entry) || entry.startsWith("/") || /^[A-Za-z]:/.test(entry)) throw new Error("归档包含不安全路径");
    const parts = entry.replace(/\/$/, "").split("/");
    if (parts.some((p) => !p || p === "." || p === "..")) throw new Error("归档包含越界路径");
    root ??= parts[0];
    if (parts[0] !== root) throw new Error("归档必须只有一个源码根目录");
  }
  // GitHub source archives need only directories and files. Reject links and
  // special files before extraction rather than trusting tar's platform defaults.
  if (!types.trim() || types.trim().split(/\r?\n/).some((line) => !/^[d-]/.test(line))) {
    throw new Error("归档包含链接或特殊文件，未解压");
  }
}

function binNames(pkg: { bin?: unknown }): string[] {
  const names = typeof pkg.bin === "string" ? ["werelay"]
    : pkg.bin && typeof pkg.bin === "object" ? Object.keys(pkg.bin) : [];
  if (names.some((name) => !/^werelay(?:-[a-z0-9-]+)?$/.test(name))) throw new Error("发布包包含非 WeRelay 命令");
  return names;
}

function mainBinPath(directory: string, pkg: { bin?: unknown }): string {
  const bin = typeof pkg.bin === "string" ? pkg.bin
    : pkg.bin && typeof pkg.bin === "object" ? (pkg.bin as Record<string, unknown>).werelay : null;
  if (typeof bin !== "string" || !bin || path.isAbsolute(bin) || bin.includes("\\") || bin.split("/").includes("..")) {
    throw new Error("发布包缺少安全的 WeRelay 命令入口");
  }
  const file = path.join(directory, bin);
  if (!fs.lstatSync(file).isFile()) throw new Error("WeRelay 命令入口不是普通文件");
  return file;
}

type ShimBackup = { file: string; copy?: string };
function backupShims(prefix: string, names: string[], backupPath: string): ShimBackup[] {
  const files = names.flatMap((name) => process.platform === "win32"
    ? [path.join(prefix, name), path.join(prefix, `${name}.cmd`), path.join(prefix, `${name}.ps1`)]
    : [path.join(prefix, "bin", name)]);
  return files.map((file, index) => {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file }; throw error; }
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("命令入口不是普通文件或链接，未替换");
    const copy = path.join(backupPath, `bin-${index}`);
    fs.cpSync(file, copy, { verbatimSymlinks: true });
    return { file, copy };
  });
}

export async function runWeRelayUpgrade(options: {
  plan: UpgradePlan;
  installPath: string;
  lockDir?: string;
  execFileImpl?: ExecLike;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onStage?: (stage: UpgradeStage) => void | Promise<void>;
}): Promise<UpgradeResult> {
  let stage: UpgradeStage = "download";
  let backupPath: string | undefined;
  let shims: ShimBackup[] = [];
  let replaced = false;
  let temp: string | undefined;
  let releaseLock: (() => void) | undefined;
  const plan = options.plan;
  const env = { ...buildCliEnvironment("codex"), npm_config_update_notifier: "false" };
  const exec = (command: string, args: string[], extra: Record<string, unknown> = {}) => {
    const execOptions = {
      env, timeout: 20 * 60_000, maxBuffer: 32 * 1024 * 1024,
      ...(!replaced && options.signal ? { signal: options.signal } : {}), ...extra,
    };
    if (options.execFileImpl) return options.execFileImpl(command, args, execOptions);
    const target = resolveSpawnTarget(command, "shell", { env, forwardArgs: args });
    return (execAsync as ExecLike)(target.file, target.args, execOptions);
  };
  const setStage = async (next: UpgradeStage) => {
    stage = next;
    options.signal?.throwIfAborted();
    await options.onStage?.(next);
    options.signal?.throwIfAborted();
  };
  try {
    const archiveUrl = buildSourceArchiveUrl(plan.tagName);
    const prefix = installPrefix(options.installPath);
    if (!archiveUrl || parseVersion(plan.tagName) !== plan.targetVersion || !parseVersion(plan.currentVersion) ||
      compareVersions(plan.targetVersion, plan.currentVersion) <= 0) throw new Error("目标不是更新的已发布版本，未安装");
    if (!prefix || await resolveGlobalInstallPath({ moduleDir: options.installPath }) !== options.installPath) {
      throw new Error("当前不是独立的全局安装，未替换源码或链接目录");
    }
    const lockDir = options.lockDir ?? path.join(CHANNEL_DATA_DIR, "updates");
    releaseLock = acquireUpdateLock(lockDir);
    if (readPackage(options.installPath).version !== plan.currentVersion) throw new Error("安装版本已变化，请重新检查更新");
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-upgrade-"));
    await setStage("download");
    const archive = path.join(temp, "release.tar.gz");
    await downloadArchive(archiveUrl, archive, options.fetchImpl ?? globalThis.fetch, options.signal);
    await setStage("extract");
    const listing = await exec("tar", ["-tzf", archive], { timeout: 60_000 });
    const types = await exec("tar", ["-tvzf", archive], { timeout: 60_000 });
    validateArchive(listing.stdout, types.stdout);
    const source = path.join(temp, "source"); ensurePrivateDir(source);
    await exec("tar", ["-xzf", archive, "-C", source, "--strip-components=1", "--no-same-owner", "--no-same-permissions"], { timeout: 60_000 });
    const pkg = readPackage(source);
    if (pkg.name !== "werelay" || pkg.version !== plan.targetVersion) throw new Error("源码包名或版本与发布记录不一致，未执行构建");
    const lock = JSON.parse(fs.readFileSync(path.join(source, "package-lock.json"), "utf8"));
    if (lock.name !== "werelay" || lock.version !== plan.targetVersion || ![2, 3].includes(lock.lockfileVersion)) {
      throw new Error("发布依赖锁与目标版本不一致");
    }
    const names = [...new Set([...binNames(readPackage(options.installPath)), ...binNames(pkg)])];
    await setStage("build");
    await exec("npm", ["ci", "--no-audit", "--no-fund"], { cwd: source });
    options.signal?.throwIfAborted();
    const { stdout } = await exec("npm", ["pack", "--json", "--silent"], { cwd: source });
    // Lifecycle scripts may write before npm's final JSON array.
    const jsonStart = stdout.trimStart().startsWith("[") ? 0 : stdout.lastIndexOf("\n[") + 1;
    const packed: unknown = JSON.parse(stdout.slice(jsonStart));
    const entry = Array.isArray(packed) && packed.length === 1 ? packed[0] : null;
    const filename = entry?.filename;
    if (!entry || entry.name !== "werelay" || entry.version !== plan.targetVersion || typeof filename !== "string" ||
      !/^werelay[^/\\]*\.tgz$/.test(filename) || path.basename(filename) !== filename) throw new Error("打包产物无效，未安装");
    const tarball = path.join(source, filename);
    if (!fs.lstatSync(tarball).isFile()) throw new Error("打包产物不是普通文件");
    await setStage("install");
    if (readPackage(options.installPath).version !== plan.currentVersion) throw new Error("安装版本已变化，请重新检查更新");
    const backups = path.join(lockDir, "backups"); ensurePrivateDir(backups);
    backupPath = fs.mkdtempSync(path.join(backups, "werelay-"));
    fs.cpSync(options.installPath, path.join(backupPath, "package"), { recursive: true, verbatimSymlinks: true });
    shims = backupShims(prefix, names, backupPath);
    writePrivateFileAtomic(path.join(backupPath, "rollback.json"), JSON.stringify({ installPath: options.installPath, shims }));
    options.signal?.throwIfAborted();
    // Once replacement starts, finish verification/rollback even during shutdown.
    // The daemon waits for this bounded job before exiting.
    replaced = true;
    await exec("npm", ["install", "--global", "--prefix", prefix, tarball, "--no-audit", "--no-fund"], { timeout: 3 * 60_000 });
    stage = "verify";
    await options.onStage?.("verify");
    const installed = readPackage(options.installPath);
    if (installed.name !== "werelay" || installed.version !== plan.targetVersion || fs.lstatSync(options.installPath).isSymbolicLink()) {
      throw new Error("安装结果与目标版本不一致");
    }
    const entrypoint = mainBinPath(options.installPath, installed);
    await exec(process.execPath, [entrypoint, "--help"], { timeout: 30_000 });
    for (const name of names) {
      if (!binNames(installed).includes(name)) continue;
      const shim = process.platform === "win32" ? path.join(prefix, `${name}.cmd`) : path.join(prefix, "bin", name);
      if (!fs.existsSync(shim)) throw new Error(`安装后缺少命令入口：${name}`);
    }
    return { status: "upgraded", from: plan.currentVersion, to: plan.targetVersion, installPath: options.installPath, backupPath };
  } catch (error) {
    let detail = error instanceof Error ? error.message : String(error);
    let rolledBack: boolean | undefined;
    if (replaced && backupPath) {
      try {
        fs.rmSync(options.installPath, { recursive: true, force: true });
        fs.cpSync(path.join(backupPath, "package"), options.installPath, { recursive: true, verbatimSymlinks: true });
        for (const shim of shims) {
          fs.rmSync(shim.file, { force: true });
          if (shim.copy) fs.cpSync(shim.copy, shim.file, { verbatimSymlinks: true });
        }
        rolledBack = readPackage(options.installPath).version === plan.currentVersion;
        if (!rolledBack) throw new Error("回退版本校验失败", { cause: error });
      } catch (rollbackError) {
        rolledBack = false;
        detail += `；自动回退失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
      }
    }
    return { status: "failed", stage, detail, backupPath, rolledBack };
  } finally {
    if (temp) { try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Isolated temp only. */ } }
    releaseLock?.();
  }
}

export function formatUpgradeResultMessage(result: UpgradeResult): string {
  if (result.status === "upgraded") return [
    `已安装 WeRelay ${result.to}（原 ${result.from}）。`,
    "当前服务尚未重启。回复“重启”让新版本生效；重启会短暂中断微信和网页连接。",
  ].join("\n");
  return ["WeRelay 更新失败。", result.detail,
    result.rolledBack === true ? "已恢复原安装和命令入口。"
      : result.rolledBack === false ? `自动回退未完成，请在电脑检查备份：${result.backupPath}`
        : "尚未替换当前安装。",
  ].join("\n");
}
