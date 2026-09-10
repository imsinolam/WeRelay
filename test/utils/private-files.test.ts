import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  appendPrivateFile,
  ensurePrivateDir,
  repairPrivateTreePermissions,
  writePrivateFileAtomic,
} from "../../src/utils/private-files.ts";

const roots: string[] = [];

function makeTempDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-private-files-"));
  roots.push(root);
  return root;
}

function mode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

const posixTest = process.platform === "win32" ? test.skip : test;

describe("private runtime filesystem helpers", () => {
  posixTest("creates and repairs private directories", () => {
    const root = makeTempDir();
    const nested = path.join(root, "workspaces", "example");

    fs.mkdirSync(nested, { recursive: true, mode: 0o755 });
    fs.chmodSync(root, 0o755);
    fs.chmodSync(path.join(root, "workspaces"), 0o755);
    fs.chmodSync(nested, 0o755);

    ensurePrivateDir(nested);

    expect(mode(nested)).toBe(PRIVATE_DIR_MODE);
  });

  posixTest("writes atomic private files and keeps appends private", () => {
    const root = makeTempDir();
    const filePath = path.join(root, "workspaces", "example", "daemon-state.json");

    writePrivateFileAtomic(filePath, "first");
    expect(fs.readFileSync(filePath, "utf8")).toBe("first");
    expect(mode(path.dirname(filePath))).toBe(PRIVATE_DIR_MODE);
    expect(mode(filePath)).toBe(PRIVATE_FILE_MODE);

    fs.chmodSync(filePath, 0o644);
    appendPrivateFile(filePath, "\nsecond");
    expect(fs.readFileSync(filePath, "utf8")).toBe("first\nsecond");
    expect(mode(filePath)).toBe(PRIVATE_FILE_MODE);
    expect(
      fs.readdirSync(path.dirname(filePath)).filter((name) => name.includes(".tmp")),
    ).toEqual([]);
  });

  posixTest("repairs an existing runtime tree without following symlinks", () => {
    const root = makeTempDir();
    const workspace = path.join(root, "workspaces", "example");
    const attachments = path.join(root, "inbound-attachments", "2026-08-08");
    const stateFile = path.join(workspace, "daemon-state.json");
    const attachmentFile = path.join(attachments, "photo.png");
    const launcherFile = path.join(root, "start-daemon.zsh");
    const outside = path.join(os.tmpdir(), `werelay-outside-${process.pid}-${Date.now()}`);

    fs.mkdirSync(workspace, { recursive: true, mode: 0o755 });
    fs.mkdirSync(attachments, { recursive: true, mode: 0o755 });
    fs.writeFileSync(stateFile, "state", { mode: 0o644 });
    fs.writeFileSync(attachmentFile, "image", { mode: 0o644 });
    fs.writeFileSync(launcherFile, "#!/bin/zsh\n", { mode: 0o755 });
    fs.writeFileSync(outside, "outside", { mode: 0o644 });
    fs.chmodSync(outside, 0o644);
    fs.symlinkSync(outside, path.join(root, "outside-link"));
    fs.chmodSync(root, 0o755);

    try {
      repairPrivateTreePermissions(root);

      expect(mode(root)).toBe(PRIVATE_DIR_MODE);
      expect(mode(workspace)).toBe(PRIVATE_DIR_MODE);
      expect(mode(attachments)).toBe(PRIVATE_DIR_MODE);
      expect(mode(stateFile)).toBe(PRIVATE_FILE_MODE);
      expect(mode(attachmentFile)).toBe(PRIVATE_FILE_MODE);
      expect(mode(launcherFile)).toBe(0o700);
      expect(mode(outside)).toBe(0o644);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

describe("private tree permission repair", () => {
  posixTest("repairs permissive modes without touching already correct entries", () => {
    const root = makeTempDir();
    const looseDir = path.join(root, "loose");
    fs.mkdirSync(looseDir, { mode: 0o755 });
    fs.chmodSync(looseDir, 0o755);
    const looseFile = path.join(looseDir, "loose.json");
    fs.writeFileSync(looseFile, "{}", { mode: 0o644 });
    fs.chmodSync(looseFile, 0o644);
    const correctFile = path.join(root, "correct.json");
    fs.writeFileSync(correctFile, "{}", { mode: PRIVATE_FILE_MODE });
    fs.chmodSync(correctFile, PRIVATE_FILE_MODE);

    const before = fs.statSync(correctFile).ctimeMs;
    repairPrivateTreePermissions(root);
    const after = fs.statSync(correctFile).ctimeMs;

    expect(mode(root)).toBe(PRIVATE_DIR_MODE);
    expect(mode(looseDir)).toBe(PRIVATE_DIR_MODE);
    expect(mode(looseFile)).toBe(PRIVATE_FILE_MODE);
    expect(mode(correctFile)).toBe(PRIVATE_FILE_MODE);
    // 权限已经正确的文件不应被再次 chmod（ctime 不变），这是启动提速的关键。
    expect(after).toBe(before);
  });

  posixTest("clears group and other bits on executables as well as special bits", () => {
    const root = makeTempDir();
    const executable = path.join(root, "tool.sh");
    fs.writeFileSync(executable, "#!/bin/sh\n");
    fs.chmodSync(executable, 0o755);
    expect(fs.statSync(executable).mode & 0o777).toBe(0o755);

    repairPrivateTreePermissions(root);

    // 可执行文件保留执行位但必须去掉组和其他用户权限；比较完整权限位
    // 还能覆盖 setuid/setgid 这类无法在普通用户下稳定构造的特殊位。
    expect(fs.statSync(executable).mode & 0o7777).toBe(0o700);
  });
});
