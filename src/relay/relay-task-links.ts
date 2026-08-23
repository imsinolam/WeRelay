import crypto from "node:crypto";
import fs from "node:fs";

import { BoundedTtlSet } from "../utils/bounded-ttl-cache.ts";
import { writePrivateFileAtomic } from "../utils/private-files.ts";
import { normalizeWeRelayRelayBaseUrl } from "./relay-protocol.ts";
import {
  decodeWeRelayTaskShortCode,
  encodeWeRelayTaskShortCode,
} from "./relay-task-short-code.ts";

export const WERELAY_RELAY_TASK_LINK_REGISTER_PATH =
  "/__werelay/device/task-links";
export const WERELAY_RELAY_TASK_LINK_ALIAS_LENGTH = 10;

const MAX_TASK_LINKS = 100_000;
const REGISTERED_ALIAS_CACHE_TTL_MS = 30 * 24 * 60 * 60_000;
const REGISTER_RETRY_MIN_MS = 1_000;
const REGISTER_RETRY_MAX_MS = 30_000;

export type WeRelayRelayTaskLinkTarget = {
  adapter: string;
  threadId: string;
};

type TaskLinkState = {
  version: 1;
  entries: Array<WeRelayRelayTaskLinkTarget & {
    alias: string;
    updatedAt: string;
  }>;
};

function normalizeTarget(
  target: WeRelayRelayTaskLinkTarget,
): WeRelayRelayTaskLinkTarget {
  const adapter = target.adapter.trim().toLowerCase();
  const threadId = target.threadId.trim();
  if (!adapter || adapter.length > 64 || !threadId || threadId.length > 512) {
    throw new Error("任务短链接目标无效。");
  }
  return { adapter, threadId };
}

export function createWeRelayRelayTaskLinkAlias(
  deviceToken: string,
  adapter: string,
  threadId: string,
): string {
  const token = deviceToken.trim();
  if (!token) {
    throw new Error("缺少 Relay 设备密钥，无法生成任务短链接。");
  }
  const target = normalizeTarget({ adapter, threadId });
  return crypto.createHmac("sha256", token)
    .update(target.adapter)
    .update("\0")
    .update(target.threadId)
    .digest("base64url")
    .slice(0, WERELAY_RELAY_TASK_LINK_ALIAS_LENGTH);
}

export class WeRelayRelayTaskLinkStore {
  private readonly deviceToken: string;
  private readonly stateFile?: string;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, WeRelayRelayTaskLinkTarget>();

  constructor(options: {
    deviceToken: string;
    stateFile?: string;
    maxEntries?: number;
  }) {
    this.deviceToken = options.deviceToken.trim();
    this.stateFile = options.stateFile;
    this.maxEntries = Math.max(1, options.maxEntries ?? MAX_TASK_LINKS);
    this.load();
  }

  register(alias: string, target: WeRelayRelayTaskLinkTarget): void {
    const normalizedAlias = alias.trim();
    const normalizedTarget = normalizeTarget(target);
    if (
      normalizedAlias !== createWeRelayRelayTaskLinkAlias(
        this.deviceToken,
        normalizedTarget.adapter,
        normalizedTarget.threadId,
      )
    ) {
      throw new Error("任务短链接校验失败。");
    }
    const existing = this.entries.get(normalizedAlias);
    if (
      existing &&
      (existing.adapter !== normalizedTarget.adapter ||
        existing.threadId !== normalizedTarget.threadId)
    ) {
      throw new Error("任务短链接发生冲突，请重试。");
    }
    this.entries.delete(normalizedAlias);
    this.entries.set(normalizedAlias, normalizedTarget);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    this.persist();
  }

  resolve(alias: string): WeRelayRelayTaskLinkTarget | null {
    return this.entries.get(alias.trim()) ?? null;
  }

  private load(): void {
    if (!this.stateFile) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as TaskLinkState;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return;
      for (const entry of parsed.entries.slice(-this.maxEntries)) {
        try {
          const target = normalizeTarget(entry);
          if (
            entry.alias === createWeRelayRelayTaskLinkAlias(
              this.deviceToken,
              target.adapter,
              target.threadId,
            )
          ) {
            this.entries.set(entry.alias, target);
          }
        } catch {
          // Invalid persisted entries are ignored.
        }
      }
    } catch {
      // Missing or invalid state is ignored.
    }
  }

  private persist(): void {
    if (!this.stateFile) return;
    const updatedAt = new Date().toISOString();
    const state: TaskLinkState = {
      version: 1,
      entries: [...this.entries.entries()].map(([alias, target]) => ({
        alias,
        ...target,
        updatedAt,
      })),
    };
    writePrivateFileAtomic(this.stateFile, `${JSON.stringify(state)}\n`);
  }
}

type PendingRegistration = WeRelayRelayTaskLinkTarget & {
  alias: string;
  retryMs: number;
  timer?: ReturnType<typeof setTimeout>;
  confirmed: Promise<void>;
  confirm: () => void;
};

export class WeRelayRelayTaskLinkClient {
  private readonly relayUrl: string;
  private readonly deviceId: string;
  private readonly deviceToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly registered = new BoundedTtlSet<string>({
    maxSize: 20_000,
    ttlMs: REGISTERED_ALIAS_CACHE_TTL_MS,
  });
  private readonly pending = new Map<string, PendingRegistration>();
  private readonly abortController = new AbortController();

  constructor(options: {
    relayUrl: string;
    deviceId: string;
    deviceToken: string;
    fetchImpl?: typeof fetch;
  }) {
    this.relayUrl = normalizeWeRelayRelayBaseUrl(options.relayUrl);
    this.deviceId = options.deviceId.trim();
    this.deviceToken = options.deviceToken.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  buildTaskUrl(
    threadId: string,
    adapter: string,
    searchParams: URLSearchParams,
  ): string {
    const target = normalizeTarget({ adapter, threadId });
    const alias = createWeRelayRelayTaskLinkAlias(
      this.deviceToken,
      target.adapter,
      target.threadId,
    );
    this.ensureRegistered(alias, target);
    const query = searchParams.toString();
    const pathname = this.registered.has(alias)
      ? `/${alias}`
      : `/t/${encodeWeRelayTaskShortCode(target.adapter, target.threadId)}`;
    return `${this.relayUrl}${pathname}${query ? `?${query}` : ""}`;
  }

  async buildConfirmedTaskUrl(
    threadId: string,
    adapter: string,
    searchParams: URLSearchParams,
    options: { timeoutMs?: number } = {},
  ): Promise<string> {
    const target = normalizeTarget({ adapter, threadId });
    const alias = createWeRelayRelayTaskLinkAlias(
      this.deviceToken,
      target.adapter,
      target.threadId,
    );
    if (!this.registered.has(alias)) {
      const registration = this.ensureRegistered(alias, target);
      const timeoutMs = Math.max(1, options.timeoutMs ?? 5_000);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        registration?.confirmed ?? Promise.resolve(),
        new Promise<void>((_, reject) => {
          // This deadline is part of the awaited operation, so it must stay
          // referenced. Bun on Windows may never fire an unref'ed timer when
          // the pending promise is otherwise the only remaining work.
          timer = setTimeout(() => reject(new Error("短链接暂时无法生成，请稍后重试。")), timeoutMs);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    }
    if (!this.registered.has(alias)) {
      throw new Error("短链接暂时无法生成，请稍后重试。");
    }
    const query = searchParams.toString();
    return `${this.relayUrl}/${alias}${query ? `?${query}` : ""}`;
  }

  async confirmTaskLinksInText(
    text: string,
    options: { timeoutMs?: number } = {},
  ): Promise<{ text: string; unresolvedCount: number }> {
    const candidates = Array.from(new Set(
      Array.from(text.matchAll(/https?:\/\/[^\s<>"'，。；！？、]+/gi))
        .map((match) => match[0]),
    ));
    let resolvedText = text;
    let unresolvedCount = 0;
    for (const candidate of candidates) {
      let url: URL;
      try {
        url = new URL(candidate);
      } catch {
        continue;
      }
      if (url.origin !== new URL(this.relayUrl).origin) continue;
      const encodedTarget = url.pathname.match(/^\/t\/([^/]+)$/)?.[1];
      if (!encodedTarget) continue;
      const target = decodeWeRelayTaskShortCode(encodedTarget);
      if (!target) continue;
      let replacement = "";
      try {
        replacement = await this.buildConfirmedTaskUrl(
          target.threadId,
          target.adapter,
          url.searchParams,
          options,
        );
      } catch {
        unresolvedCount += 1;
      }
      resolvedText = resolvedText.split(candidate).join(replacement);
    }
    resolvedText = resolvedText
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (unresolvedCount > 0) {
      const notice = "任务短链接暂时无法生成，可发送“任务”从列表进入。";
      resolvedText = resolvedText ? `${resolvedText}\n\n${notice}` : notice;
    }
    return { text: resolvedText, unresolvedCount };
  }

  async close(): Promise<void> {
    this.abortController.abort();
    for (const registration of this.pending.values()) {
      if (registration.timer) clearTimeout(registration.timer);
    }
    this.pending.clear();
  }

  private ensureRegistered(
    alias: string,
    target: WeRelayRelayTaskLinkTarget,
  ): PendingRegistration | null {
    if (this.registered.has(alias)) return null;
    const existing = this.pending.get(alias);
    if (existing) return existing;
    let confirm: () => void = () => {};
    const confirmed = new Promise<void>((resolve) => { confirm = resolve; });
    const registration: PendingRegistration = {
      alias,
      ...target,
      retryMs: REGISTER_RETRY_MIN_MS,
      confirmed,
      confirm,
    };
    this.pending.set(alias, registration);
    void this.register(registration);
    return registration;
  }

  private async register(registration: PendingRegistration): Promise<void> {
    if (this.abortController.signal.aborted) return;
    try {
      const response = await this.fetchImpl(
        `${this.relayUrl}${WERELAY_RELAY_TASK_LINK_REGISTER_PATH}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.deviceToken}`,
            "content-type": "application/json",
            "x-werelay-device-id": this.deviceId,
          },
          body: JSON.stringify({
            alias: registration.alias,
            adapter: registration.adapter,
            threadId: registration.threadId,
          }),
          signal: this.abortController.signal,
        },
      );
      if (!response.ok) {
        throw new Error(`Relay 返回 ${response.status}`);
      }
      this.pending.delete(registration.alias);
      this.registered.add(registration.alias);
      registration.confirm();
      return;
    } catch {
      if (this.abortController.signal.aborted) return;
      registration.timer = setTimeout(() => {
        registration.timer = undefined;
        void this.register(registration);
      }, registration.retryMs);
      registration.timer.unref?.();
      registration.retryMs = Math.min(
        REGISTER_RETRY_MAX_MS,
        registration.retryMs * 2,
      );
    }
  }
}
