import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RelayWarmSnapshotStore } from "../../src/relay/relay-warm-snapshot-store.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporarySnapshot(): { directory: string; filePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-warm-snapshot-"));
  directories.push(directory);
  return { directory, filePath: path.join(directory, "state", "snapshot.bin") };
}

function entry(index: number, sizeBytes = 4, updatedAtMs = Date.now()) {
  return {
    path: `/api/tasks/task-${index}/messages?limit=5&adapter=codex`,
    updatedAtMs,
    sizeBytes,
    response: {
      protocolVersion: 1 as const,
      commandId: `response-${index}`,
      statusCode: 200,
      headers: { "content-type": "application/json" },
      bodyBase64: Buffer.from(JSON.stringify({ index, padding: "x".repeat(Math.max(0, sizeBytes - 12)) })).toString("base64"),
    },
  };
}

function writeSnapshot(
  filePath: string,
  token: string,
  entries: ReturnType<typeof entry>[],
  options: { now?: () => number; retentionMs?: number } = {},
): void {
  const store = new RelayWarmSnapshotStore({
    filePath,
    deviceToken: token,
    debounceMs: 0,
    ...options,
  });
  store.save(entries);
  store.close();
}

describe("Relay warm snapshot store", () => {
  test("writes an encrypted private file and restores it after restart", () => {
    const { directory, filePath } = temporarySnapshot();
    const token = "device-token-for-encrypted-snapshot";
    writeSnapshot(filePath, token, [entry(1), entry(2)]);

    const raw = fs.readFileSync(filePath);
    expect(raw.subarray(0, 8).toString("ascii")).toBe("WRLWSNAP");
    expect(raw.includes(Buffer.from(token))).toBe(false);
    // Windows exposes synthetic mode bits rather than POSIX access permissions.
    // Encryption and round-trip assertions below still run on every platform.
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    }
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(["snapshot.bin"]);

    const restored = new RelayWarmSnapshotStore({ filePath, deviceToken: token }).load();
    expect(restored.map((item) => item.path)).toEqual([
      entry(1).path,
      entry(2).path,
    ]);
    expect(restored[0]?.response.bodyBase64).toBe(entry(1).response.bodyBase64);
  });

  test("deletes a snapshot that cannot be decrypted with the current device token", () => {
    const { filePath } = temporarySnapshot();
    writeSnapshot(filePath, "old-device-token", [entry(1)]);
    expect(fs.existsSync(filePath)).toBe(true);

    const restored = new RelayWarmSnapshotStore({
      filePath,
      deviceToken: "new-device-token",
    }).load();
    expect(restored).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test("drops expired and invalid entries while keeping the newest bounded set", () => {
    const nowMs = 1_000_000_000;
    const { filePath } = temporarySnapshot();
    const entries = [
      entry(1, 4, nowMs - 8 * 24 * 60 * 60_000),
      entry(2, 4, nowMs - 3_000),
      entry(3, 4, nowMs - 2_000),
      entry(4, 4, nowMs - 1_000),
    ];
    writeSnapshot(filePath, "token", entries, { now: () => nowMs });

    const restored = new RelayWarmSnapshotStore({
      filePath,
      deviceToken: "token",
      retentionMs: 7 * 24 * 60 * 60_000,
      maxPaths: 2,
      now: () => nowMs,
    }).load();
    expect(restored.map((item) => item.path)).toEqual([
      entry(3).path,
      entry(4).path,
    ]);
  });

  test("enforces the byte budget by dropping the least recently updated entry", () => {
    const nowMs = 1_000_000_000;
    const { filePath } = temporarySnapshot();
    const entries = [
      entry(1, 5, nowMs - 3_000),
      entry(2, 5, nowMs - 2_000),
      entry(3, 5, nowMs - 1_000),
    ];
    writeSnapshot(filePath, "token", entries, { now: () => nowMs });

    const restored = new RelayWarmSnapshotStore({
      filePath,
      deviceToken: "token",
      maxPaths: 64,
      maxBytes: 10,
      debounceMs: 0,
      now: () => nowMs,
    }).load();
    expect(restored.map((item) => item.path)).toEqual([
      entry(2).path,
      entry(3).path,
    ]);

    const saved = new RelayWarmSnapshotStore({
      filePath,
      deviceToken: "token",
      maxPaths: 64,
      maxBytes: 10,
      debounceMs: 0,
      now: () => nowMs,
    });
    saved.save([entries[0]!, entries[1]!, entries[2]!]);
    saved.close();
    expect(new RelayWarmSnapshotStore({
      filePath,
      deviceToken: "token",
      maxPaths: 64,
      maxBytes: 10,
      now: () => nowMs,
    }).load().map((item) => item.path)).toEqual([
      entry(2).path,
      entry(3).path,
    ]);
  });

  test("ignores corrupted or unknown-version files and removes them", () => {
    for (const bytes of [
      Buffer.from("not a snapshot"),
      Buffer.concat([Buffer.from("WRLWSNAP"), Buffer.from([2, 0, 0, 0, 1, 2, 3])]),
    ]) {
      const { filePath } = temporarySnapshot();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, bytes);
      expect(new RelayWarmSnapshotStore({
        filePath,
        deviceToken: "token",
      }).load()).toEqual([]);
      expect(fs.existsSync(filePath)).toBe(false);
    }
  });
});
