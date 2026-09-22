import { createHash } from "node:crypto";

type Rejection = { token: string; until: number; attempts: number };
/**
 * `uncertain` entries may carry a timestamp so a permanently unresolvable
 * send cannot block that request forever. Older state files store a bare
 * fingerprint string, which stays valid and is treated as freshly recorded.
 */
export type ContextSendGuardState = {
  rejected: [string, Rejection][];
  uncertain: (string | { key: string; at: number; scope?: string })[];
};
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * How long an unconfirmed send keeps its request blocked.
 *
 * The marker exists to stop a blind replay after a crash mid-send, which is
 * correct and must stay. But WeChat's send result is sometimes permanently
 * unknowable (the request is rejected while the context token is stale), and
 * fail-closed forever means the affected request — and with it the whole
 * serialized send chain — never recovers without manual state surgery.
 * After this window the marker is dropped so a fresh attempt can decide.
 */
const UNCERTAIN_TTL_MS = 10 * 60_000;

/** 拒绝退避的指数步数上限与最长等待，保证持续失败后仍会再次尝试。 */
const MAX_REJECTION_BACKOFF_STEPS = 4;
const MAX_REJECTION_BACKOFF_MS = 30 * 60_000;

/** Persist only one-way fingerprints, never credentials, recipients, or message bodies. */
export class ContextSendGuard {
  private readonly rejected: Map<string, Rejection>;
  private readonly uncertain: Map<string, { at: number; scope?: string }>;
  /** Runtime-only reverse index; persisted state intentionally contains no recipient data. */
  private readonly requestRecipients = new Map<string, string>();
  constructor(private readonly options: {
    now?: () => number;
    cooldownMs?: number;
    uncertainTtlMs?: number;
    initial?: ContextSendGuardState | null;
    persist?: (state: ContextSendGuardState) => void;
  } = {}) {
    const now = options.now ?? Date.now;
    this.rejected = new Map((Array.isArray(options.initial?.rejected) ? options.initial.rejected : []).filter((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) return false;
      const [key, value] = entry;
      return typeof key === "string" && /^[a-f0-9]{64}$/.test(key) && value &&
        /^[a-f0-9]{64}$/.test(value.token) && Number.isFinite(value.until) &&
        Number.isInteger(value.attempts) && value.attempts > 0;
    }).slice(-500));
    const ttl = this.uncertainTtlMs();
    this.uncertain = new Map<string, { at: number; scope?: string }>();
    for (const entry of Array.isArray(options.initial?.uncertain) ? options.initial.uncertain : []) {
      // Accept both the current object form and the legacy bare fingerprint.
      const key = typeof entry === "string" ? entry : entry?.key;
      const at = typeof entry === "string" ? now() : entry?.at;
      const scope = typeof entry === "string" ? undefined : entry?.scope;
      if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) continue;
      // Drop markers that already outlived the window instead of loading a
      // permanent block from disk.
      if (typeof at === "number" && Number.isFinite(at) && now() - at >= ttl) continue;
      this.uncertain.set(key, {
        at: typeof at === "number" && Number.isFinite(at) ? at : now(),
        ...(typeof scope === "string" && /^[a-f0-9]{64}$/.test(scope) ? { scope } : {}),
      });
    }
  }

  private uncertainTtlMs(): number {
    const configured = this.options.uncertainTtlMs;
    return typeof configured === "number" && Number.isFinite(configured) && configured >= 0
      ? configured
      : UNCERTAIN_TTL_MS;
  }

  /** Drop unconfirmed markers that outlived the recovery window. */
  private pruneUncertain(now: number): void {
    const ttl = this.uncertainTtlMs();
    for (const [key, entry] of this.uncertain) {
      if (now - entry.at >= ttl) this.uncertain.delete(key);
    }
  }

  snapshot(): ContextSendGuardState {
    return {
      rejected: [...this.rejected].map(([key, value]) => [key, { ...value }]),
      uncertain: [...this.uncertain].map(([key, entry]) => ({ key, ...entry })),
    };
  }

  /**
   * A fresh inbound context token is an explicit recovery boundary. Persisted
   * uncertainty stores only the one-way recipient scope, so the same recovery
   * also works after a daemon restart without writing recipient identifiers.
   */
  markContextRefreshed(recipient: string): void {
    const scope = fingerprint(recipient);
    let changed = false;
    for (const [request, entry] of this.uncertain) {
      const runtimeRecipient = this.requestRecipients.get(request);
      if (entry.scope !== scope && runtimeRecipient !== recipient) continue;
      this.requestRecipients.delete(request);
      changed = this.uncertain.delete(request) || changed;
    }
    if (changed) this.persist();
  }

  /**
   * Check whether a stable request may begin before doing expensive preparation
   * such as uploading media. This intentionally does not create an in-flight
   * marker; `send()` still owns the write-ahead transition immediately before
   * the upstream request.
   */
  assertCanAttempt(params: {
    recipient: string;
    requestKey?: string;
    getToken: () => string;
  }): void {
    const scope = fingerprint(params.recipient);
    const request = fingerprint(`${scope}\0${params.requestKey ?? "default"}`);
    const now = this.options.now ?? Date.now;
    this.pruneUncertain(now());
    if (this.uncertain.has(request) || this.uncertain.size >= 500) {
      throw new Error("微信上次发送结果未确认，已暂停自动重发，避免重复消息；请核实送达结果。");
    }
    const token = params.getToken();
    const blocked = this.rejected.get(scope);
    // 只按退避期拦截。此前额外的 attempts >= 3 永久条件会形成死锁：
    // 永不允许再尝试 → 永远无法成功 → rejected 永不清除 → 该收件人的发送
    // 链路（含被它串行化的后续消息）再也不会恢复，即使退避期早已过去、
    // context token 也没有变化。指数退避本身已经足够保守（1、5、25、125
    // 分钟），因此退避期结束就允许再试一次。
    if (blocked && blocked.token === fingerprint(token) && blocked.until > now()) {
      throw new Error("微信发送恢复处于退避期，稍后自动重试。");
    }
  }

  private persist(): void {
    while (this.rejected.size > 500) this.rejected.delete(this.rejected.keys().next().value!);
    // Fail closed if uncertain outcome storage fills; never evict and blindly resend.
    this.options.persist?.(this.snapshot());
  }

  async send(params: {
    recipient: string;
    requestKey?: string;
    getToken: () => string;
    send: (token: string) => Promise<void>;
    isExplicitRejection: (error: unknown) => boolean;
  }): Promise<void> {
    const scope = fingerprint(params.recipient);
    const request = fingerprint(`${scope}\0${params.requestKey ?? "default"}`);
    const now = this.options.now ?? Date.now;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Every actual attempt must re-read the current token and its protection.
      // An overlapping request may have rejected that token while we awaited an older one.
      this.assertCanAttempt(params);
      const token = params.getToken();
      // Write-ahead marker: a crash during the request cannot trigger blind replay.
      this.requestRecipients.set(request, params.recipient);
      this.uncertain.set(request, { at: now(), scope });
      this.persist();
      try {
        await params.send(token);
        this.uncertain.delete(request);
        this.requestRecipients.delete(request);
        if (this.rejected.get(scope)?.token === fingerprint(token)) this.rejected.delete(scope);
        this.persist();
        return;
      } catch (error) {
        if (!params.isExplicitRejection(error)) {
          this.uncertain.set(request, { at: now(), scope });
          this.persist();
          throw new Error("微信本次发送结果未确认，已暂停自动重发，避免重复消息。", { cause: error });
        }
        const current = params.getToken();
        if (current !== token) {
          // Retire only this old request marker; preserve the newer token's state.
          this.uncertain.delete(request);
          this.requestRecipients.delete(request);
          this.persist();
          if (attempt === 0) continue;
          throw error;
        }
        const previous = this.rejected.get(scope);
        const attempts = previous?.token === fingerprint(token) ? previous.attempts + 1 : 1;
        // 退避按 5 倍指数增长，但设上限，避免持续失败时退避长到事实上无法恢复。
        const cooldownMs = (this.options.cooldownMs ?? 60_000) *
          5 ** Math.min(attempts - 1, MAX_REJECTION_BACKOFF_STEPS);
        this.rejected.set(scope, { token: fingerprint(token), attempts,
          until: now() + Math.min(cooldownMs, MAX_REJECTION_BACKOFF_MS) });
        // One atomic snapshot transitions in-flight -> rejected, including its count.
        // A restart must see either uncertainty or the final rejection, never neither.
        this.uncertain.delete(request);
        this.requestRecipients.delete(request);
        this.persist();
        throw error;
      }
    }
  }
}
