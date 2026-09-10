import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  buildWorkspaceKey,
  ensureChannelDataDir,
  getWorkspaceChannelPaths,
  migrateLegacyChannelFiles,
  normalizeWorkspacePath,
  resolveChannelDataDir,
} from "../../src/wechat/channel-config.ts";

const posixTest = process.platform === "win32" ? test.skip : test;

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "werelay-channel-config-"));
}

function writeTextFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function readTextFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

describe("workspace channel paths", () => {
  posixTest("repairs an existing data root to private permissions", () => {
    const root = makeTempDir();
    const dataDir = path.join(root, "data");
    const workspaceDir = path.join(dataDir, "workspaces", "repo");
    const stateFile = path.join(workspaceDir, "daemon-state.json");

    try {
      fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o755 });
      fs.writeFileSync(stateFile, "{}", { mode: 0o644 });
      fs.chmodSync(dataDir, 0o755);
      fs.chmodSync(path.join(dataDir, "workspaces"), 0o755);
      fs.chmodSync(workspaceDir, 0o755);

      ensureChannelDataDir(dataDir);

      expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(workspaceDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("normalizes a workspace path to an absolute path", () => {
    const resolved = normalizeWorkspacePath(".");
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  test("builds a stable workspace key for the same cwd", () => {
    const cwd = path.resolve("test-workspaces", "repo");

    expect(buildWorkspaceKey(cwd)).toBe(buildWorkspaceKey(cwd));
  });

  test("builds different workspace paths for different cwd values", () => {
    const repoA = path.resolve("test-workspaces", "repo-a");
    const repoB = path.resolve("test-workspaces", "repo-b");

    const pathsA = getWorkspaceChannelPaths(repoA);
    const pathsB = getWorkspaceChannelPaths(repoB);

    expect(pathsA.workspaceDir).not.toBe(pathsB.workspaceDir);
    expect(pathsA.stateFile.endsWith("bridge-state.json")).toBe(true);
    expect(pathsA.daemonStateFile.endsWith("daemon-state.json")).toBe(true);
    expect(pathsA.endpointFile.endsWith("codex-panel-endpoint.json")).toBe(true);
  });

  test("uses .werelay as the default user data directory", () => {
    expect(resolveChannelDataDir({} as NodeJS.ProcessEnv, "C:\\Users\\tester")).toBe(
      path.join("C:\\Users\\tester", ".werelay"),
    );
  });

  test("uses the new data-dir env var when provided", () => {
    expect(
      resolveChannelDataDir(
        {
          WERELAY_DATA_DIR: "C:\\bridge-data",
        } as NodeJS.ProcessEnv,
        "C:\\Users\\tester",
      ),
    ).toBe(path.resolve("C:\\bridge-data"));
  });

  test("does not use the former product data-dir env var as the active directory", () => {
    expect(
      resolveChannelDataDir(
        {
          CLI_BRIDGE_DATA_DIR: "C:\\old-product-data",
        } as NodeJS.ProcessEnv,
        "C:\\Users\\tester",
      ),
    ).toBe(path.join("C:\\Users\\tester", ".werelay"));
  });

  test("does not keep the DeskRelay data-dir env var as a public alias", () => {
    expect(
      resolveChannelDataDir(
        {
          DESKRELAY_DATA_DIR: "C:\\old-deskrelay-data",
        } as NodeJS.ProcessEnv,
        "C:\\Users\\tester",
      ),
    ).toBe(path.join("C:\\Users\\tester", ".werelay"));
  });

  test("does not use the legacy Claude data-dir env var as the active directory", () => {
    expect(
      resolveChannelDataDir(
        {
          CLAUDE_WECHAT_CHANNEL_DATA_DIR: "C:\\old-bridge-data",
        } as NodeJS.ProcessEnv,
        "C:\\Users\\tester",
      ),
    ).toBe(path.join("C:\\Users\\tester", ".werelay"));
  });
});

describe("legacy channel data migration", () => {
  test("copies legacy data into an empty active data directory", () => {
    const root = makeTempDir();
    try {
      const channelDataDir = path.join(root, "new");
      const legacyDataDir = path.join(root, "legacy");
      const logs: string[] = [];

      writeTextFile(path.join(legacyDataDir, "account.json"), '{"token":"old"}');
      writeTextFile(path.join(legacyDataDir, "sync_buf.txt"), "sync");
      writeTextFile(
        path.join(legacyDataDir, "context_tokens.json"),
        '{"session":"ctx"}',
      );
      writeTextFile(
        path.join(legacyDataDir, "update-check.json"),
        '{"checked":true}',
      );
      writeTextFile(path.join(legacyDataDir, "bridge.log"), "old log");
      writeTextFile(path.join(legacyDataDir, "bridge.lock.json"), "lock");
      writeTextFile(
        path.join(legacyDataDir, "workspaces", "repo", "bridge-state.json"),
        "workspace state",
      );
      writeTextFile(
        path.join(
          legacyDataDir,
          "inbound-attachments",
          "2026-05-22",
          "photo.jpg",
        ),
        "image",
      );

      const migrated = migrateLegacyChannelFiles((message) => logs.push(message), {
        channelDataDir,
        legacyDataDirs: [legacyDataDir],
      });

      expect(migrated).toEqual([
        "credentials",
        "sync state",
        "context tokens",
        "update check cache",
        "workspace state",
        "inbound attachments",
        "legacy bridge log",
      ]);
      expect(readTextFile(path.join(channelDataDir, "account.json"))).toBe(
        '{"token":"old"}',
      );
      expect(readTextFile(path.join(channelDataDir, "sync_buf.txt"))).toBe("sync");
      expect(readTextFile(path.join(channelDataDir, "context_tokens.json"))).toBe(
        '{"session":"ctx"}',
      );
      expect(readTextFile(path.join(channelDataDir, "update-check.json"))).toBe(
        '{"checked":true}',
      );
      expect(readTextFile(path.join(channelDataDir, "legacy-bridge.log"))).toBe(
        "old log",
      );
      expect(
        readTextFile(
          path.join(channelDataDir, "workspaces", "repo", "bridge-state.json"),
        ),
      ).toBe("workspace state");
      expect(
        readTextFile(
          path.join(
            channelDataDir,
            "inbound-attachments",
            "2026-05-22",
            "photo.jpg",
          ),
        ),
      ).toBe("image");
      expect(fs.existsSync(path.join(channelDataDir, "bridge.lock.json"))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(channelDataDir, "bridge.log"))).toBe(false);
      expect(fs.existsSync(path.join(legacyDataDir, "account.json"))).toBe(true);
      expect(logs[0]).toContain("Migrated legacy credentials");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("prefers DeskRelay data and fills missing files from older sources", () => {
    const root = makeTempDir();
    try {
      const channelDataDir = path.join(root, "new");
      const deskRelayDataDir = path.join(root, ".deskrelay");
      const olderDataDir = path.join(root, ".cli-bridge");

      writeTextFile(path.join(deskRelayDataDir, "account.json"), "deskrelay account");
      writeTextFile(path.join(olderDataDir, "account.json"), "older account");
      writeTextFile(path.join(olderDataDir, "sync_buf.txt"), "older sync");

      const migrated = migrateLegacyChannelFiles(undefined, {
        channelDataDir,
        legacyDataDirs: [deskRelayDataDir, olderDataDir],
      });

      expect(migrated).toEqual(["credentials", "sync state"]);
      expect(readTextFile(path.join(channelDataDir, "account.json"))).toBe(
        "deskrelay account",
      );
      expect(readTextFile(path.join(channelDataDir, "sync_buf.txt"))).toBe(
        "older sync",
      );
      expect(readTextFile(path.join(deskRelayDataDir, "account.json"))).toBe(
        "deskrelay account",
      );
      expect(readTextFile(path.join(olderDataDir, "account.json"))).toBe(
        "older account",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not overwrite existing active files or directories", () => {
    const root = makeTempDir();
    try {
      const channelDataDir = path.join(root, "new");
      const legacyDataDir = path.join(root, "legacy");
      const logs: string[] = [];

      writeTextFile(path.join(channelDataDir, "account.json"), "new account");
      writeTextFile(path.join(channelDataDir, "legacy-bridge.log"), "new log");
      writeTextFile(
        path.join(channelDataDir, "workspaces", "repo", "bridge-state.json"),
        "new workspace",
      );

      writeTextFile(path.join(legacyDataDir, "account.json"), "old account");
      writeTextFile(path.join(legacyDataDir, "sync_buf.txt"), "old sync");
      writeTextFile(path.join(legacyDataDir, "bridge.log"), "old log");
      writeTextFile(
        path.join(legacyDataDir, "workspaces", "repo", "bridge-state.json"),
        "old workspace",
      );

      const migrated = migrateLegacyChannelFiles((message) => logs.push(message), {
        channelDataDir,
        legacyDataDirs: [legacyDataDir],
      });

      expect(migrated).toEqual(["sync state"]);
      expect(readTextFile(path.join(channelDataDir, "account.json"))).toBe(
        "new account",
      );
      expect(readTextFile(path.join(channelDataDir, "legacy-bridge.log"))).toBe(
        "new log",
      );
      expect(
        readTextFile(
          path.join(channelDataDir, "workspaces", "repo", "bridge-state.json"),
        ),
      ).toBe("new workspace");
      expect(readTextFile(path.join(channelDataDir, "sync_buf.txt"))).toBe(
        "old sync",
      );
      expect(logs.at(-1)).toContain(
        "Skipped existing WeRelay data: credentials, workspace state, legacy bridge log",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("fills missing workspace files without overwriting an already-created workspace", () => {
    const root = makeTempDir();
    try {
      const channelDataDir = path.join(root, "new");
      const legacyDataDir = path.join(root, "legacy");

      writeTextFile(
        path.join(channelDataDir, "workspaces", "repo", "daemon-state.json"),
        "new daemon state",
      );
      writeTextFile(
        path.join(legacyDataDir, "workspaces", "repo", "daemon-state.json"),
        "old daemon state",
      );
      writeTextFile(
        path.join(legacyDataDir, "workspaces", "repo", "codex-mobile-auth.json"),
        "legacy mobile auth",
      );
      writeTextFile(
        path.join(legacyDataDir, "workspaces", "repo", "relay-command-journal.json"),
        "legacy command journal",
      );

      const migrated = migrateLegacyChannelFiles(undefined, {
        channelDataDir,
        legacyDataDirs: [legacyDataDir],
      });

      expect(migrated).toEqual(["workspace state"]);
      expect(
        readTextFile(
          path.join(channelDataDir, "workspaces", "repo", "daemon-state.json"),
        ),
      ).toBe("new daemon state");
      expect(
        readTextFile(
          path.join(channelDataDir, "workspaces", "repo", "codex-mobile-auth.json"),
        ),
      ).toBe("legacy mobile auth");
      expect(
        readTextFile(
          path.join(channelDataDir, "workspaces", "repo", "relay-command-journal.json"),
        ),
      ).toBe("legacy command journal");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps first-source precedence and fills missing data from later sources", () => {
    const root = makeTempDir();
    try {
      const channelDataDir = path.join(root, "new");
      const firstLegacyDataDir = path.join(root, "first-legacy");
      const secondLegacyDataDir = path.join(root, "second-legacy");

      writeTextFile(path.join(firstLegacyDataDir, "account.json"), "first account");
      writeTextFile(path.join(secondLegacyDataDir, "account.json"), "second account");
      writeTextFile(path.join(secondLegacyDataDir, "sync_buf.txt"), "second sync");

      const migrated = migrateLegacyChannelFiles(undefined, {
        channelDataDir,
        legacyDataDirs: [firstLegacyDataDir, secondLegacyDataDir],
      });

      expect(migrated).toEqual(["credentials", "sync state"]);
      expect(readTextFile(path.join(channelDataDir, "account.json"))).toBe(
        "first account",
      );
      expect(readTextFile(path.join(channelDataDir, "sync_buf.txt"))).toBe(
        "second sync",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("legacy migration completion marker", () => {
  posixTest("skips repeated legacy comparison after one completed migration", () => {
    const root = makeTempDir();
    const channelDataDir = path.join(root, "werelay");
    const legacyDataDir = path.join(root, "cli-bridge");
    const logs: string[] = [];

    try {
      writeTextFile(path.join(legacyDataDir, "account.json"), '{"token":"old"}');
      const first = migrateLegacyChannelFiles((message) => logs.push(message), {
        channelDataDir,
        legacyDataDirs: [legacyDataDir],
      });
      expect(first).toContain("credentials");
      expect(fs.existsSync(path.join(channelDataDir, ".legacy-migration-complete")))
        .toBe(true);

      // 第二次启动不应再逐项比对遗留目录，也不再重复报告跳过项。
      logs.length = 0;
      const second = migrateLegacyChannelFiles((message) => logs.push(message), {
        channelDataDir,
        legacyDataDirs: [legacyDataDir],
      });
      expect(second).toEqual([]);
      expect(logs).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  posixTest("still migrates on first startup when no marker exists yet", () => {
    const root = makeTempDir();
    const channelDataDir = path.join(root, "werelay");
    const legacyDataDir = path.join(root, "cli-bridge");

    try {
      writeTextFile(path.join(legacyDataDir, "sync_buf.txt"), "sync");
      const migrated = migrateLegacyChannelFiles(undefined, {
        channelDataDir,
        legacyDataDirs: [legacyDataDir],
      });

      expect(migrated).toContain("sync state");
      expect(readTextFile(path.join(channelDataDir, "sync_buf.txt"))).toBe("sync");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
