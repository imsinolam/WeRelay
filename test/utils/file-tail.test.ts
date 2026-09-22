import { describe, expect, test, spyOn } from "bun:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readFileTail, scanFileTail, scanFileTailReverse } from "../../src/utils/file-tail.ts";

function writeTempFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-file-tail-"));
  const file = path.join(dir, "session.log");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

describe("file-tail primitive", () => {
  test("stops reverse I/O after the newest requested line", () => {
    const file = writeTempFile("x".repeat(2_000_000) + "\nolder\nnewest\n");
    const read = spyOn(fs, "readSync");
    try {
      const seen: string[] = [];
      expect(scanFileTailReverse(file, { scanLimitBytes: 4_000_000 }, (line) => {
        seen.push(line); return false;
      })).toBe(1);
      expect(seen).toEqual(["newest"]);
      expect(read.mock.calls.length).toBe(1);
      expect(read.mock.calls[0]?.[3]).toBe(65_536);
    } finally { read.mockRestore(); }
  });

  test("drops only the incomplete leading fragment at the byte limit", () => {
    const file = writeTempFile("older\n甲🙂乙\nlast");
    const seen: string[] = [];
    scanFileTailReverse(file, { scanLimitBytes: 7, chunkBytes: 2 }, (line) => { seen.push(line); });
    expect(seen).toEqual(["last"]);
  });

  test("decodes a long UTF-8 line once and preserves blank lines", () => {
    const long = "甲🙂乙".repeat(10_000);
    const file = writeTempFile("\n" + long + "\r\n\nend");
    const seen: string[] = [];
    scanFileTailReverse(file, { scanLimitBytes: 1_000_000, chunkBytes: 31 }, (line) => { seen.push(line); });
    expect(seen).toEqual(["end", "", long, ""]);
  });

  test("reads the bounded tail of a small file in order", () => {
    const file = writeTempFile("line1\nline2\nline3\n");
    const lines = readFileTail(file, { scanLimitBytes: 1024 * 1024 });
    expect(lines).toEqual(["line1", "line2", "line3"]);
  });

  test("keeps only the newest lines when the file exceeds the scan limit", () => {
    const rows = Array.from({ length: 2000 }, (_, index) => `row-${index}`);
    const file = writeTempFile(rows.join("\n") + "\n");
    const lines = readFileTail(file, { scanLimitBytes: 256 });
    expect(lines).not.toBeNull();
    expect((lines ?? []).length).toBeGreaterThan(0);
    expect((lines ?? []).length).toBeLessThan(rows.length);
    // The newest line must always be present.
    expect((lines ?? []).at(-1)).toBe("row-1999");
  });

  test("reports null for a missing file", () => {
    expect(readFileTail("/nonexistent/werelay-tail.log", { scanLimitBytes: 1024 })).toBeNull();
  });

  test("delivers line flags for first and last scanned lines", () => {
    const file = writeTempFile("a\nb\nc\n");
    const flags: Array<{ text: string; isFirst: boolean; isLast: boolean }> = [];
    const count = scanFileTail(file, { scanLimitBytes: 1024 * 1024 }, (line) => {
      flags.push({ text: line.text, isFirst: line.isFirst, isLast: line.isLast });
    });
    expect(count).toBe(3);
    expect(flags.map((flag) => flag.text)).toEqual(["a", "b", "c"]);
    expect(flags[0]?.isFirst).toBe(true);
    expect(flags[0]?.isLast).toBe(false);
    expect(flags[2]?.isLast).toBe(true);
  });

  test("handles a file without a trailing newline", () => {
    const file = writeTempFile("alpha\nbeta");
    const lines = readFileTail(file, { scanLimitBytes: 1024 * 1024 });
    expect(lines).toEqual(["alpha", "beta"]);
  });

  test("returns zero lines for an empty file", () => {
    const file = writeTempFile("");
    expect(readFileTail(file, { scanLimitBytes: 1024 * 1024 })).toEqual([]);
  });
  test("preserves UTF-8 characters and CRLF split across tiny chunks", () => {
    const file = writeTempFile("甲🙂乙\r\n\r\n丙丁\n末尾");
    for (const chunkBytes of [1, 2, 3, 5, 7]) {
      expect(readFileTail(file, { scanLimitBytes: 1024, chunkBytes })).toEqual([
        "甲🙂乙", "", "丙丁", "末尾",
      ]);
    }
  });

});
