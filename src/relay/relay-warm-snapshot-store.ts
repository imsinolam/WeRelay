import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  WeRelayRelayCommandResponse,
  WeRelayRelayHeaderMap,
} from "./relay-protocol.ts";

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_MAGIC = Buffer.from("WRLWSNAP", "ascii");
const SNAPSHOT_SALT = "werelay-relay-warm-snapshot-v1";
const SNAPSHOT_AAD = Buffer.from("werelay-relay-warm-snapshot", "utf8");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const LENGTH_BYTES = 4;
const MAX_PATH_BYTES = 8 * 1024;
const MAX_SAVED_PATHS = 64;
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_DEBOUNCE_MS = 2_000;

export type WarmSnapshotEntry = {
  path: string;
  response: WeRelayRelayCommandResponse;
  updatedAtMs: number;
  sizeBytes: number;
};

type SnapshotFile = {
  version: 1;
  savedAtMs: number;
  entries: WarmSnapshotEntry[];
};

export type WarmSnapshotStoreOptions = {
  filePath: string;
  deviceToken: string;
  retentionMs?: number;
  maxPaths?: number;
  maxBytes?: number;
  debounceMs?: number;
  now?: () => number;
};

function isHeaderMap(value: unknown): value is WeRelayRelayHeaderMap {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(
      (item) => typeof item === "string" ||
        (Array.isArray(item) && item.every((part) => typeof part === "string")),
    );
}

function parseEntry(value: unknown): WarmSnapshotEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const response = record.response;
  if (
    typeof record.path !== "string" ||
    !record.path.startsWith("/api/") ||
    Buffer.byteLength(record.path) > MAX_PATH_BYTES ||
    !Number.isSafeInteger(record.updatedAtMs) ||
    Number(record.updatedAtMs) < 0 ||
    !Number.isSafeInteger(record.sizeBytes) ||
    Number(record.sizeBytes) < 0 ||
    !response ||
    typeof response !== "object" ||
    Array.isArray(response)
  ) return null;
  const responseRecord = response as Record<string, unknown>;
  if (
    responseRecord.protocolVersion !== 1 ||
    typeof responseRecord.commandId !== "string" ||
    !Number.isInteger(responseRecord.statusCode) ||
    Number(responseRecord.statusCode) < 200 ||
    Number(responseRecord.statusCode) >= 300 ||
    !isHeaderMap(responseRecord.headers) ||
    (responseRecord.bodyBase64 !== undefined &&
      typeof responseRecord.bodyBase64 !== "string")
  ) return null;
  return {
    path: record.path,
    updatedAtMs: Number(record.updatedAtMs),
    sizeBytes: Number(record.sizeBytes),
    response: {
      protocolVersion: 1,
      commandId: responseRecord.commandId,
      statusCode: Number(responseRecord.statusCode),
      headers: responseRecord.headers,
      ...(typeof responseRecord.bodyBase64 === "string"
        ? { bodyBase64: responseRecord.bodyBase64 }
        : {}),
    },
  };
}

function boundedEntries(
  entries: WarmSnapshotEntry[],
  maxPaths: number,
  maxBytes: number,
): WarmSnapshotEntry[] {
  const unique = new Map<string, WarmSnapshotEntry>();
  for (const entry of entries) {
    if (entry.updatedAtMs < 0 || entry.sizeBytes < 0) continue;
    unique.set(entry.path, entry);
  }
  const newestFirst = [...unique.values()].sort(
    (left, right) => right.updatedAtMs - left.updatedAtMs,
  );
  const selected: WarmSnapshotEntry[] = [];
  let totalBytes = 0;
  for (const entry of newestFirst) {
    if (selected.length >= maxPaths) break;
    if (entry.sizeBytes > maxBytes - totalBytes) continue;
    selected.push(entry);
    totalBytes += entry.sizeBytes;
  }
  return selected.sort((left, right) => left.updatedAtMs - right.updatedAtMs);
}

export class RelayWarmSnapshotStore {
  readonly filePath: string;
  readonly retentionMs: number;
  readonly maxPaths: number;
  readonly maxBytes: number;
  readonly debounceMs: number;

  private readonly key: Buffer;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: WarmSnapshotEntry[] | null = null;
  private closed = false;

  constructor(options: WarmSnapshotStoreOptions) {
    this.filePath = options.filePath;
    this.retentionMs = Math.max(0, options.retentionMs ?? DEFAULT_RETENTION_MS);
    this.maxPaths = Math.max(1, Math.min(
      MAX_SAVED_PATHS,
      Math.floor(options.maxPaths ?? MAX_SAVED_PATHS),
    ));
    this.maxBytes = Math.max(0, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));
    this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.now = options.now ?? (() => Date.now());
    this.key = Buffer.from(crypto.hkdfSync(
      "sha256",
      Buffer.from(options.deviceToken, "utf8"),
      SNAPSHOT_SALT,
      SNAPSHOT_AAD,
      32,
    ));
  }

  load(): WarmSnapshotEntry[] {
    let encrypted: Buffer;
    try {
      encrypted = fs.readFileSync(this.filePath);
    } catch {
      return [];
    }
    const removeInvalid = () => {
      try {
        fs.rmSync(this.filePath, { force: true });
      } catch {
        // A failed cleanup must not make Relay startup fail.
      }
      return [];
    };
    try {
      const minimumBytes = SNAPSHOT_MAGIC.length + 1 + IV_BYTES + TAG_BYTES;
      if (encrypted.length <= minimumBytes) return removeInvalid();
      const magic = encrypted.subarray(0, SNAPSHOT_MAGIC.length);
      if (!magic.equals(SNAPSHOT_MAGIC)) return removeInvalid();
      const version = encrypted[SNAPSHOT_MAGIC.length];
      if (version !== SNAPSHOT_VERSION) return removeInvalid();
      const lengthOffset = SNAPSHOT_MAGIC.length + 1;
      const plaintextLength = encrypted.readUInt32BE(lengthOffset);
      const ivStart = lengthOffset + LENGTH_BYTES;
      const iv = encrypted.subarray(ivStart, ivStart + IV_BYTES);
      const tag = encrypted.subarray(ivStart + IV_BYTES, ivStart + IV_BYTES + TAG_BYTES);
      const ciphertext = encrypted.subarray(ivStart + IV_BYTES + TAG_BYTES);
      if (ciphertext.length !== plaintextLength) return removeInvalid();
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAAD(SNAPSHOT_AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      const parsed = JSON.parse(plaintext.toString("utf8")) as SnapshotFile;
      if (
        !parsed ||
        parsed.version !== SNAPSHOT_VERSION ||
        !Number.isSafeInteger(parsed.savedAtMs) ||
        !Array.isArray(parsed.entries)
      ) return removeInvalid();
      if (
        plaintextLength > this.maxBytes + MAX_SAVED_PATHS * MAX_PATH_BYTES ||
        parsed.entries.length > MAX_SAVED_PATHS
      ) return removeInvalid();
      const cutoff = this.now() - this.retentionMs;
      const snapshotCurrent = parsed.savedAtMs >= cutoff;
      const valid = parsed.entries
        .map(parseEntry)
        .filter((entry): entry is WarmSnapshotEntry =>
          Boolean(entry && (entry.updatedAtMs >= cutoff ||
            entry.updatedAtMs === 0 && snapshotCurrent)),
        );
      return boundedEntries(valid, this.maxPaths, this.maxBytes);
    } catch {
      return removeInvalid();
    }
  }

  save(entries: Iterable<WarmSnapshotEntry>): void {
    const selected = boundedEntries(
      [...entries].filter((entry) =>
        (entry.updatedAtMs === 0 ||
          entry.updatedAtMs >= this.now() - this.retentionMs) &&
        entry.sizeBytes <= this.maxBytes &&
        entry.response.statusCode >= 200 &&
        entry.response.statusCode < 300,
      ),
      this.maxPaths,
      this.maxBytes,
    );
    this.pending = selected;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const entries = this.pending;
    this.pending = null;
    if (!entries) return;
    this.write(entries);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flush();
  }

  private write(entries: WarmSnapshotEntry[]): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
    const plaintext = Buffer.from(JSON.stringify({
      version: SNAPSHOT_VERSION,
      savedAtMs: this.now(),
      entries,
    } satisfies SnapshotFile), "utf8");
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(SNAPSHOT_AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const header = Buffer.alloc(SNAPSHOT_MAGIC.length + 1 + LENGTH_BYTES);
    SNAPSHOT_MAGIC.copy(header, 0);
    header[SNAPSHOT_MAGIC.length] = SNAPSHOT_VERSION;
    header.writeUInt32BE(plaintext.length, SNAPSHOT_MAGIC.length + 1);
    const payload = Buffer.concat([header, iv, tag, ciphertext]);
    const temporary = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    try {
      const descriptor = fs.openSync(
        temporary,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
      try {
        fs.writeFileSync(descriptor, payload);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.filePath);
      if (process.platform !== "win32") fs.chmodSync(this.filePath, 0o600);
      try {
        const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
        try {
          fs.fsyncSync(directoryDescriptor);
        } finally {
          fs.closeSync(directoryDescriptor);
        }
      } catch {
        // Directory fsync is not supported on every platform.
      }
    } catch {
      // Cache persistence is best effort and must not fail Relay traffic.
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
