import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initLocaleFromEnv } from "../i18n/index.ts";
import {
  appendPrivateFile,
  ensurePrivateDir,
  repairPrivateTreePermissions,
  writePrivateFileAtomic,
} from "../utils/private-files.ts";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(MODULE_DIR, "..", "..");

export const DEFAULT_BASE_URL =
  process.env.WECHAT_ILINK_BASE_URL?.trim() || "https://ilinkai.weixin.qq.com";
export const BOT_TYPE = "3";

export function resolveChannelDataDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): string {
  const configured = env.WERELAY_DATA_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(homeDir, ".werelay");
}

export const CHANNEL_DATA_DIR = resolveChannelDataDir();

export const CREDENTIALS_FILE = path.join(CHANNEL_DATA_DIR, "account.json");
export const SYNC_BUF_FILE = path.join(CHANNEL_DATA_DIR, "sync_buf.txt");
export const CONTEXT_CACHE_FILE = path.join(
  CHANNEL_DATA_DIR,
  "context_tokens.json",
);
export const BRIDGE_STATE_FILE = path.join(CHANNEL_DATA_DIR, "bridge-state.json");
export const BRIDGE_LOG_FILE = path.join(CHANNEL_DATA_DIR, "bridge.log");

// Hard cap for bridge.log. Long-running daemons otherwise grow it without bound.
export const BRIDGE_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

/**
 * Append a line to a log file, trimming it down to the tail half whenever it
 * exceeds BRIDGE_LOG_MAX_BYTES. Trimming is best-effort under concurrent
 * writers (a few lines may be lost during a trim) but keeps the file bounded.
 */
export function appendBoundedLog(filePath: string, line: string): void {
  ensurePrivateDir(path.dirname(filePath));
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > BRIDGE_LOG_MAX_BYTES) {
      const keepSize = Math.floor(BRIDGE_LOG_MAX_BYTES / 2);
      const fd = fs.openSync(filePath, "r");
      try {
        const tail = Buffer.alloc(keepSize);
        const bytesRead = fs.readSync(fd, tail, 0, keepSize, stat.size - keepSize);
        writePrivateFileAtomic(filePath, tail.subarray(0, bytesRead));
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    // File missing or unreadable: fall through to a plain append.
  }
  appendPrivateFile(filePath, line);
}
export const BRIDGE_LOCK_FILE = path.join(CHANNEL_DATA_DIR, "bridge.lock.json");
export const DAEMON_ENDPOINT_FILE = path.join(CHANNEL_DATA_DIR, "daemon-endpoint.json");
export const CODEX_PANEL_ENDPOINT_FILE = path.join(
  CHANNEL_DATA_DIR,
  "codex-panel-endpoint.json",
);
export const WORKSPACES_DIR = path.join(CHANNEL_DATA_DIR, "workspaces");
export const INBOUND_MESSAGE_CLAIMS_DIR = path.join(
  CHANNEL_DATA_DIR,
  "inbound-message-claims",
);
export const INBOUND_ATTACHMENTS_DIR = path.join(
  CHANNEL_DATA_DIR,
  "inbound-attachments",
);

initLocaleFromEnv();

export type WorkspaceChannelPaths = {
  workspaceDir: string;
  stateFile: string;
  daemonStateFile: string;
  endpointFile: string;
};

export type WorkspaceEndpointAdapter =
  | "codex"
  | "claude"
  | "tclaude"
  | "grok"
  | "codebuddy"
  | "reasonix"
  | "workbuddy"
  | "deepseek"
  | "opencode"
  | "shell";

type LegacyChannelSource = {
  dataDir: string;
};

export type LegacyChannelMigrationOptions = {
  channelDataDir?: string;
  legacyDataDirs?: string[];
};

type LegacyMigrationItem = {
  label: string;
  sourceName: string;
  targetName: string;
  kind: "file" | "directory";
};

const LEGACY_DESKRELAY_DATA_DIR = path.join(os.homedir(), ".deskrelay");
const LEGACY_CLI_BRIDGE_DATA_DIR = path.join(os.homedir(), ".cli-bridge");
const LEGACY_GLOBAL_CHANNEL_DATA_DIR = path.join(
  os.homedir(),
  ".claude",
  "channels",
  "wechat",
);
const LEGACY_REPO_CHANNEL_DATA_DIR = path.join(
  PROJECT_DIR,
  "~",
  ".claude",
  "channels",
  "wechat",
);
const LEGACY_ENV_CHANNEL_DATA_DIR = process.env.CLAUDE_WECHAT_CHANNEL_DATA_DIR?.trim()
  ? path.resolve(process.env.CLAUDE_WECHAT_CHANNEL_DATA_DIR.trim())
  : "";
const LEGACY_CHANNEL_SOURCE_DIRS = [
  LEGACY_DESKRELAY_DATA_DIR,
  LEGACY_CLI_BRIDGE_DATA_DIR,
  LEGACY_ENV_CHANNEL_DATA_DIR,
  LEGACY_GLOBAL_CHANNEL_DATA_DIR,
  LEGACY_REPO_CHANNEL_DATA_DIR,
].filter(Boolean);
const LEGACY_CHANNEL_SOURCES: LegacyChannelSource[] = LEGACY_CHANNEL_SOURCE_DIRS.map((dataDir) => ({
  dataDir,
}));

const LEGACY_MIGRATION_ITEMS: LegacyMigrationItem[] = [
  {
    label: "credentials",
    sourceName: "account.json",
    targetName: "account.json",
    kind: "file",
  },
  {
    label: "sync state",
    sourceName: "sync_buf.txt",
    targetName: "sync_buf.txt",
    kind: "file",
  },
  {
    label: "context tokens",
    sourceName: "context_tokens.json",
    targetName: "context_tokens.json",
    kind: "file",
  },
  {
    label: "update check cache",
    sourceName: "update-check.json",
    targetName: "update-check.json",
    kind: "file",
  },
  {
    label: "workspace state",
    sourceName: "workspaces",
    targetName: "workspaces",
    kind: "directory",
  },
  {
    label: "inbound attachments",
    sourceName: "inbound-attachments",
    targetName: "inbound-attachments",
    kind: "directory",
  },
  {
    label: "legacy bridge log",
    sourceName: "bridge.log",
    targetName: "legacy-bridge.log",
    kind: "file",
  },
];

const repairedChannelDataDirs = new Set<string>();

export function ensureChannelDataDir(
  channelDataDir = CHANNEL_DATA_DIR,
): void {
  ensurePrivateDir(channelDataDir);
  const normalized = path.resolve(channelDataDir);
  if (!repairedChannelDataDirs.has(normalized)) {
    repairPrivateTreePermissions(normalized);
    repairedChannelDataDirs.add(normalized);
  }
}

export function normalizeWorkspacePath(cwd: string): string {
  return path.resolve(cwd);
}

function buildComparableWorkspacePath(cwd: string): string {
  const normalized = normalizeWorkspacePath(cwd);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sanitizeWorkspaceSegment(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return sanitized || "workspace";
}

export function buildWorkspaceKey(cwd: string): string {
  const normalized = normalizeWorkspacePath(cwd);
  const digest = crypto
    .createHash("sha256")
    .update(buildComparableWorkspacePath(normalized))
    .digest("hex")
    .slice(0, 12);
  const label = sanitizeWorkspaceSegment(path.basename(normalized));
  return `${label}-${digest}`;
}

export function getWorkspaceChannelPaths(cwd: string): WorkspaceChannelPaths {
  const workspaceDir = path.join(WORKSPACES_DIR, buildWorkspaceKey(cwd));
  return {
    workspaceDir,
    stateFile: path.join(workspaceDir, "bridge-state.json"),
    daemonStateFile: path.join(workspaceDir, "daemon-state.json"),
    endpointFile: path.join(workspaceDir, "codex-panel-endpoint.json"),
  };
}

export function getWorkspaceAdapterEndpointFile(
  cwd: string,
  adapter: WorkspaceEndpointAdapter,
): string {
  return path.join(
    getWorkspaceChannelPaths(cwd).workspaceDir,
    `${adapter}-companion-endpoint.json`,
  );
}

export function ensureWorkspaceChannelDir(cwd: string): WorkspaceChannelPaths {
  ensureChannelDataDir();
  const paths = getWorkspaceChannelPaths(cwd);
  ensurePrivateDir(WORKSPACES_DIR);
  ensurePrivateDir(paths.workspaceDir);
  return paths;
}

function isSamePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function legacySourceHasMigratableData(source: LegacyChannelSource): boolean {
  return LEGACY_MIGRATION_ITEMS.some((item) => {
    const sourcePath = path.join(source.dataDir, item.sourceName);
    if (!fs.existsSync(sourcePath)) {
      return false;
    }
    try {
      const stat = fs.statSync(sourcePath);
      return item.kind === "directory" ? stat.isDirectory() : stat.isFile();
    } catch {
      return false;
    }
  });
}

function isExistingDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function copyMissingDirectoryEntries(sourceDir: string, targetDir: string): boolean {
  let copied = false;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (!fs.existsSync(targetPath)) {
      fs.cpSync(sourcePath, targetPath, { recursive: entry.isDirectory() });
      copied = true;
      continue;
    }
    if (entry.isDirectory()) {
      if (
        isExistingDirectory(targetPath) &&
        copyMissingDirectoryEntries(sourcePath, targetPath)
      ) {
        copied = true;
      }
    }
  }
  return copied;
}

export function migrateLegacyChannelFiles(
  log?: (message: string) => void,
  options: LegacyChannelMigrationOptions = {},
): string[] {
  const channelDataDir = options.channelDataDir ?? CHANNEL_DATA_DIR;
  const legacySources = (options.legacyDataDirs ?? LEGACY_CHANNEL_SOURCE_DIRS).map(
    (dataDir) => ({ dataDir }),
  );
  const migrated: string[] = [];
  const skippedExisting = new Set<string>();
  ensureChannelDataDir(channelDataDir);
  // 遗留目录可能保留很久，而目录类目每次启动都要递归比对全部条目。实测
  // ~/.cli-bridge 有 8000 多个文件、目标目录有 14000 多个文件，逐个
  // existsSync 会让每次启动多花数分钟且期间服务不可用。完成过一次完整
  // 比对后写下标记，后续启动直接跳过；标记文件本身不参与迁移比对。
  const migrationMarkerFile = path.join(channelDataDir, ".legacy-migration-complete");
  const migrationCompleted = fs.existsSync(migrationMarkerFile);
  if (migrationCompleted) {
    return migrated;
  }

  for (const legacySource of legacySources) {
    if (
      isSamePath(legacySource.dataDir, channelDataDir) ||
      !legacySourceHasMigratableData(legacySource)
    ) {
      continue;
    }

    for (const item of LEGACY_MIGRATION_ITEMS) {
      const sourcePath = path.join(legacySource.dataDir, item.sourceName);
      const targetPath = path.join(channelDataDir, item.targetName);
      if (!fs.existsSync(sourcePath)) {
        continue;
      }
      const stat = fs.statSync(sourcePath);
      if (item.kind === "directory") {
        if (!stat.isDirectory()) {
          continue;
        }
        if (fs.existsSync(targetPath)) {
          if (
            !isExistingDirectory(targetPath) ||
            !copyMissingDirectoryEntries(sourcePath, targetPath)
          ) {
            skippedExisting.add(item.label);
            continue;
          }
        } else {
          fs.cpSync(sourcePath, targetPath, { recursive: true });
        }
      } else {
        if (!stat.isFile()) {
          continue;
        }
        if (fs.existsSync(targetPath)) {
          skippedExisting.add(item.label);
          continue;
        }
        ensurePrivateDir(path.dirname(targetPath));
        fs.copyFileSync(sourcePath, targetPath);
      }
      migrated.push(item.label);
      log?.(
        `Migrated legacy ${item.label} from ${legacySource.dataDir} to ${targetPath}`,
      );
    }
  }

  repairPrivateTreePermissions(channelDataDir);

  if (skippedExisting.size > 0) {
    log?.(
      `Skipped existing WeRelay data: ${[...skippedExisting].join(", ")}`,
    );
  }

  // 完整比对已完成，记录标记让后续启动不再重复递归比较遗留目录。
  try {
    writePrivateFileAtomic(migrationMarkerFile, `${new Date().toISOString()}\n`);
  } catch {
    // 标记写入失败不影响本次迁移结果，下次启动会再比对一次。
  }

  return migrated;
}
