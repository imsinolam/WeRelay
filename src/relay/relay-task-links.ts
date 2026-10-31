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

/**
 * 短别名只使用大写字母与数字。
 *
 * 此前用 base64url，会产出 `-` 和 `_`。微信不把以这两个符号结尾的裸链接整体
 * 识别为链接——实测 https://host/Eg5CwU5rU_ 结尾的下划线被排除在可点击范围
 * 之外，用户点到的其实是截断后的地址，因而无法访问。
 *
 * 改用无歧义的字母数字表即可彻底避免；长度保持不变，因此已注册的旧别名
 * 仍能按原样解析，不需要迁移既有链接。
 */
const TASK_LINK_ALIAS_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const MAX_TASK_LINKS = 100_000;
const REGISTERED_ALIAS_CACHE_TTL_MS = 30 * 24 * 60 * 60_000;
const REGISTER_RETRY_MIN_MS = 1_000;
const REGISTER_RETRY_MAX_MS = 30_000;
const REGISTER_REQUEST_TIMEOUT_MS = 2_000;

export type TaskLinkRegistrationFailure = {
  reason: "timeout" | "http" | "protocol" | "network";
  status?: number;
};

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
  const digest = crypto.createHmac("sha256", token)
    .update(target.adapter)
    .update("\0")
    .update(target.threadId)
    .digest();
  // 把摘要逐字节映射到字母数字表，保留原有长度与确定性。
  let alias = "";
  for (let index = 0; alias.length < WERELAY_RELAY_TASK_LINK_ALIAS_LENGTH; index += 1) {
    alias += TASK_LINK_ALIAS_ALPHABET[
      digest[index % digest.length]! % TASK_LINK_ALIAS_ALPHABET.length
    ];
  }
  return alias;
}

/**
 * 旧版别名（base64url）。仅用于读取历史注册记录，避免已发出的链接失效；
 * 新链接一律走 createWeRelayRelayTaskLinkAlias。
 */
function createLegacyWeRelayRelayTaskLinkAlias(
  deviceToken: string,
  adapter: string,
  threadId: string,
): string {
  const token = deviceToken.trim();
  if (!token) return "";
  const target = normalizeTarget({ adapter, threadId });
  return crypto.createHmac("sha256", token)
    .update(target.adapter)
    .update("\0")
    .update(target.threadId)
    .digest("base64url")
    .slice(0, WERELAY_RELAY_TASK_LINK_ALIAS_LENGTH);
}

/** 别名是否属于该目标（兼容新旧两套生成规则）。 */
function aliasMatchesTarget(
  deviceToken: string,
  alias: string,
  target: WeRelayRelayTaskLinkTarget,
): boolean {
  if (alias === createWeRelayRelayTaskLinkAlias(
    deviceToken,
    target.adapter,
    target.threadId,
  )) return true;
  const legacy = createLegacyWeRelayRelayTaskLinkAlias(
    deviceToken,
    target.adapter,
    target.threadId,
  );
  return Boolean(legacy) && alias === legacy;
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
    // 接受新别名，也接受此前已发出的 base64url 别名，避免老链接失效。
    if (!aliasMatchesTarget(this.deviceToken, normalizedAlias, normalizedTarget)) {
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
          // 历史记录里的旧别名同样保留，否则重启后老链接会失效。
          if (aliasMatchesTarget(this.deviceToken, entry.alias, target)) {
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
  inFlight: boolean;
  confirmed: Promise<boolean>;
  confirm: (success: boolean) => void;
};

export class WeRelayRelayTaskLinkClient {
  private readonly relayUrl: string;
  private readonly deviceId: string;
  private readonly deviceToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly onRegistrationFailure?: (failure: TaskLinkRegistrationFailure) => void;
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
    requestTimeoutMs?: number;
    onRegistrationFailure?: (failure: TaskLinkRegistrationFailure) => void;
  }) {
    this.relayUrl = normalizeWeRelayRelayBaseUrl(options.relayUrl);
    this.deviceId = options.deviceId.trim();
    this.deviceToken = options.deviceToken.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REGISTER_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("短链接注册超时必须为正数。");
    }
    this.onRegistrationFailure = options.onRegistrationFailure;
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
    if (this.abortController.signal.aborted) {
      throw new Error("短链接暂时无法生成，请稍后重试。");
    }
    const target = normalizeTarget({ adapter, threadId });
    const alias = createWeRelayRelayTaskLinkAlias(
      this.deviceToken,
      target.adapter,
      target.threadId,
    );
    if (!this.registered.has(alias)) {
      // An explicit send/list request must not wait behind a 30-second
      // background backoff after connectivity has already recovered.
      const registration = this.ensureRegistered(alias, target, true);
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
      registration.confirm(false);
    }
    this.pending.clear();
  }

  private ensureRegistered(
    alias: string,
    target: WeRelayRelayTaskLinkTarget,
    urgent = false,
  ): PendingRegistration | null {
    if (this.abortController.signal.aborted) {
      throw new Error("短链接暂时无法生成，请稍后重试。");
    }
    if (this.registered.has(alias)) return null;
    const existing = this.pending.get(alias);
    if (existing) {
      if (urgent && existing.timer && !existing.inFlight) {
        clearTimeout(existing.timer);
        existing.timer = undefined;
        void this.register(existing);
      }
      return existing;
    }
    let confirm: (success: boolean) => void = () => {};
    const confirmed = new Promise<boolean>((resolve) => { confirm = resolve; });
    const registration: PendingRegistration = {
      alias,
      ...target,
      retryMs: REGISTER_RETRY_MIN_MS,
      inFlight: false,
      confirmed,
      confirm,
    };
    this.pending.set(alias, registration);
    void this.register(registration);
    return registration;
  }

  private async register(registration: PendingRegistration): Promise<void> {
    if (this.abortController.signal.aborted || registration.inFlight) return;
    registration.inFlight = true;
    const requestController = new AbortController();
    const stop = () => requestController.abort();
    this.abortController.signal.addEventListener("abort", stop, { once: true });
    let failure: TaskLinkRegistrationFailure = { reason: "network" };
    const timeout = setTimeout(() => {
      failure = { reason: "timeout" };
      requestController.abort();
    }, this.requestTimeoutMs);
    // Race as well as abort: custom transports may ignore AbortSignal, and
    // reading an acknowledgement body can stall after headers have arrived.
    let cancel: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error("registration aborted"));
      requestController.signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      const attempt = async () => {
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
            signal: requestController.signal,
            redirect: "error",
          },
        );
        if (requestController.signal.aborted || !response.ok) {
          if (!requestController.signal.aborted) failure = { reason: "http", status: response.status };
          void response.body?.cancel().catch(() => {});
          throw new Error("Relay 短链接注册未完成。");
        }
        failure = { reason: "protocol" };
        const acknowledgement: unknown = await response.json();
        if (!acknowledgement || typeof acknowledgement !== "object" ||
            !("ok" in acknowledgement) || acknowledgement.ok !== true) {
          throw new Error("Relay 没有确认短链接注册。");
        }
      };
      await Promise.race([attempt(), cancelled]);
      if (this.abortController.signal.aborted || this.pending.get(registration.alias) !== registration) return;
      this.pending.delete(registration.alias);
      this.registered.add(registration.alias);
      registration.confirm(true);
      return;
    } catch {
      if (this.abortController.signal.aborted) return;
      // Never expose response bodies, URLs, device IDs, aliases or task IDs.
      try { this.onRegistrationFailure?.(failure); } catch { /* diagnostics are non-fatal */ }
      registration.timer = setTimeout(() => {
        registration.timer = undefined;
        void this.register(registration);
      }, registration.retryMs);
      registration.timer.unref?.();
      registration.retryMs = Math.min(
        REGISTER_RETRY_MAX_MS,
        registration.retryMs * 2,
      );
    } finally {
      clearTimeout(timeout);
      this.abortController.signal.removeEventListener("abort", stop);
      requestController.signal.removeEventListener("abort", cancel);
      registration.inFlight = false;
    }
  }
}
