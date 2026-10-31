/**
 * Storage for vendor push registrations.
 *
 * Registrations are per install, not per account: a phone that signs in with a
 * different access token must stop receiving the previous account's
 * notifications. Entries therefore carry the server origin they were registered
 * against, and are dropped once the vendor rejects the token.
 */

import fs from "node:fs";
import path from "node:path";

import type { PushProviderId, PushRegistration } from "./vendor-push.ts";

export type StoredPushRegistration = PushRegistration & {
  /** Server origin the app registered against. */
  origin: string;
  /** Stable per-install id supplied by the app when it has one. */
  deviceId?: string;
  updatedAtMs: number;
  /** Set after a vendor reports the token as invalid. */
  invalidatedAtMs?: number;
};

type PushStoreFile = {
  version: 1;
  registrations: StoredPushRegistration[];
};

const MAX_REGISTRATIONS = 32;

export class PushRegistrationStore {
  private readonly filePath: string;
  private cache: PushStoreFile | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private read(): PushStoreFile {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as PushStoreFile;
      if (parsed?.version === 1 && Array.isArray(parsed.registrations)) {
        this.cache = parsed;
        return parsed;
      }
    } catch {
      // Missing or corrupt file: start empty rather than failing requests.
    }
    this.cache = { version: 1, registrations: [] };
    return this.cache;
  }

  private write(next: PushStoreFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
    this.cache = next;
  }

  /**
   * Records or refreshes a registration. Re-registering the same token replaces
   * the previous entry so a rotated token cannot leave a stale duplicate behind.
   */
  upsert(entry: Omit<StoredPushRegistration, "updatedAtMs">): StoredPushRegistration {
    const current = this.read();
    const stored: StoredPushRegistration = { ...entry, updatedAtMs: Date.now() };
    const others = current.registrations.filter(
      (item) => !(item.provider === stored.provider && item.token === stored.token),
    );
    const registrations = [stored, ...others]
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .slice(0, MAX_REGISTRATIONS);
    this.write({ version: 1, registrations });
    return stored;
  }

  /** Registrations worth trying for this origin. */
  active(origin: string): StoredPushRegistration[] {
    return this.read().registrations.filter(
      (item) => item.origin === origin && !item.invalidatedAtMs,
    );
  }

  /** Marks a token dead after the vendor rejects it, so it is not retried forever. */
  invalidate(provider: PushProviderId, token: string): void {
    const current = this.read();
    let changed = false;
    const registrations = current.registrations.map((item) => {
      if (item.provider !== provider || item.token !== token || item.invalidatedAtMs) return item;
      changed = true;
      return { ...item, invalidatedAtMs: Date.now() };
    });
    if (changed) this.write({ version: 1, registrations });
  }

  /** Drops every registration bound to an origin, used on logout/host switch. */
  clearOrigin(origin: string): void {
    const current = this.read();
    const registrations = current.registrations.filter((item) => item.origin !== origin);
    if (registrations.length !== current.registrations.length) {
      this.write({ version: 1, registrations });
    }
  }

  all(): StoredPushRegistration[] {
    return [...this.read().registrations];
  }
}
