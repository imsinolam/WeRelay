/** Bounded UTF-8 tail reads. Decode complete lines only, never partial chunks. */
import fs from "node:fs";

export type FileTailScanOptions = {
  /** Maximum bytes scanned from the end of the file. */
  scanLimitBytes: number;
  /** Chunk size used for each reverse read. */
  chunkBytes?: number;
};

export type FileTailLine = {
  text: string;
  isFirst: boolean;
  isLast: boolean;
};

/**
 * Visit complete lines newest first. Returning false stops I/O immediately.
 * A line spanning chunks is decoded once, after its bytes have been joined;
 * repeatedly concatenating/splitting a growing string is quadratic for long
 * JSONL records and also corrupts UTF-8 characters at chunk boundaries.
 * The incomplete oldest line is discarded if the scan limit is reached.
 */
export function scanFileTailReverse(
  filePath: string,
  options: FileTailScanOptions,
  onLine: (text: string) => boolean | void,
): number | null {
  let descriptor: number;
  try { descriptor = fs.openSync(filePath, "r"); } catch { return null; }
  try {
    let size: number;
    try { size = fs.fstatSync(descriptor).size; } catch { return null; }
    const limit = Math.max(0, Math.min(size, Math.floor(options.scanLimitBytes) || 0));
    const chunkBytes = Number.isFinite(options.chunkBytes) && (options.chunkBytes ?? 0) > 0
      ? Math.max(1, Math.floor(options.chunkBytes!)) : 64 * 1024;
    if (size === 0 || limit === 0) return 0;
    let endOffset = size;
    let scannedBytes = 0;
    let count = 0;
    let terminated = false;
    let fragments: Buffer[] = [];
    let fragmentBytes = 0;
    const append = (part: Buffer): void => {
      if (part.length === 0) return;
      fragments.push(part);
      fragmentBytes += part.length;
    };
    const emit = (part: Buffer): boolean => {
      append(part);
      const line = fragments.length === 1 ? fragments[0]!
        : Buffer.concat(fragments.reverse(), fragmentBytes);
      fragments = [];
      fragmentBytes = 0;
      // Ignore only the empty fragment after the file's final newline.
      if (!terminated && line.length === 0) return true;
      const length = terminated && line.at(-1) === 13 ? line.length - 1 : line.length;
      count += 1;
      return onLine(line.subarray(0, length).toString("utf8")) !== false;
    };
    while (endOffset > 0 && scannedBytes < limit) {
      const length = Math.min(chunkBytes, endOffset, limit - scannedBytes);
      const startOffset = endOffset - length;
      const buffer = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        let bytes: number;
        try { bytes = fs.readSync(descriptor, buffer, read, length - read, startOffset + read); }
        catch { return null; }
        // The file may have been truncated/replaced during the scan.
        if (bytes === 0) return null;
        read += bytes;
      }
      let right = length;
      for (let newline = buffer.lastIndexOf(10, right - 1); newline >= 0;) {
        if (!emit(buffer.subarray(newline + 1, right))) return count;
        terminated = true;
        right = newline;
        if (newline === 0) break;
        newline = buffer.lastIndexOf(10, newline - 1);
      }
      append(buffer.subarray(0, right));
      endOffset = startOffset;
      scannedBytes += length;
    }
    if (endOffset === 0) emit(Buffer.alloc(0));
    return count;
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Visit the bounded tail in file order, preserving first/last flags. */
export function scanFileTail(
  filePath: string,
  options: FileTailScanOptions,
  onLine: (line: FileTailLine) => void,
): number | null {
  const lines: string[] = [];
  const count = scanFileTailReverse(filePath, options, (line) => { lines.push(line); });
  if (count === null) return null;
  lines.reverse();
  for (let index = 0; index < lines.length; index += 1) {
    onLine({ text: lines[index]!, isFirst: index === 0, isLast: index === lines.length - 1 });
  }
  return lines.length;
}

export function readFileTail(filePath: string, options: FileTailScanOptions): string[] | null {
  const lines: string[] = [];
  const count = scanFileTail(filePath, options, ({ text }) => { lines.push(text); });
  return count === null ? null : lines;
}
