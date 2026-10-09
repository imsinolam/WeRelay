import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquirePiOwnerLock } from "../../src/bridge/pi-owner-lock.ts";

test("two managed Pi owners cannot launch concurrently; private lock is released by holder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pi-lock-test-"));
  try {
    const release = acquirePiOwnerLock(root);
    // Windows uses ACLs rather than POSIX mode bits; lock ownership is tested below on every OS.
    if (process.platform !== "win32") {
      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(root, "owner.lock")).mode & 0o777).toBe(0o600);
    }
    expect(() => acquirePiOwnerLock(root)).toThrow(/已有 WeRelay 管理的 Pi 窗口/);
    release();
    const next = acquirePiOwnerLock(root);
    next();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("dead Pi companion lock can be reclaimed after an unclean exit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pi-stale-lock-"));
  try {
    fs.writeFileSync(path.join(root, "owner.lock"), JSON.stringify({pid: 999999999, nonce: "old"}), {mode: 0o600});
    const release = acquirePiOwnerLock(root);
    expect(JSON.parse(fs.readFileSync(path.join(root, "owner.lock"), "utf8")).pid).toBe(process.pid);
    release();
  } finally { fs.rmSync(root, {recursive:true,force:true}); }
});
