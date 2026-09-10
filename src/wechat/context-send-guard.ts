import { createHash } from "node:crypto";

type Rejection = { token: string; until: number; attempts: number };
export type ContextSendGuardState = { rejected: [string, Rejection][]; uncertain: string[] };
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

/** Persist only one-way fingerprints, never credentials, recipients, or message bodies. */
export class ContextSendGuard {
  private readonly rejected: Map<string, Rejection>;
  private readonly uncertain: Set<string>;
  constructor(private readonly options: {
    now?: () => number;
    cooldownMs?: number;
    initial?: ContextSendGuardState | null;
    persist?: (state: ContextSendGuardState) => void;
  } = {}) {
    this.rejected = new Map((Array.isArray(options.initial?.rejected) ? options.initial.rejected : []).filter((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) return false;
      const [key, value] = entry;
      return typeof key === "string" && /^[a-f0-9]{64}$/.test(key) && value &&
        /^[a-f0-9]{64}$/.test(value.token) && Number.isFinite(value.until) &&
        Number.isInteger(value.attempts) && value.attempts > 0;
    }).slice(-500));
    this.uncertain = new Set((Array.isArray(options.initial?.uncertain) ? options.initial.uncertain : []).filter((key) => /^[a-f0-9]{64}$/.test(key)).slice(-500));
  }

  snapshot(): ContextSendGuardState {
    return { rejected: [...this.rejected].map(([key, value]) => [key, { ...value }]), uncertain: [...this.uncertain] };
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
      if (this.uncertain.has(request) || this.uncertain.size >= 500) {
        throw new Error("微信上次发送结果未确认，已暂停自动重发，避免重复消息；请核实送达结果。");
      }
      const token = params.getToken();
      const blocked = this.rejected.get(scope);
      if (blocked && blocked.token === fingerprint(token) && (blocked.attempts >= 3 || blocked.until > now())) {
        throw new Error(blocked.attempts >= 3
          ? "微信连续拒绝发送，已暂停此上下文自动重试；收到新上下文后恢复。"
          : "微信发送恢复处于退避期，稍后自动重试。");
      }
      // Write-ahead marker: a crash during the request cannot trigger blind replay.
      this.uncertain.add(request);
      this.persist();
      try {
        await params.send(token);
        this.uncertain.delete(request);
        if (this.rejected.get(scope)?.token === fingerprint(token)) this.rejected.delete(scope);
        this.persist();
        return;
      } catch (error) {
        if (!params.isExplicitRejection(error)) {
          this.uncertain.add(request);
          this.persist();
          throw new Error("微信本次发送结果未确认，已暂停自动重发，避免重复消息。", { cause: error });
        }
        const current = params.getToken();
        if (current !== token) {
          // Retire only this old request marker; preserve the newer token's state.
          this.uncertain.delete(request);
          this.persist();
          if (attempt === 0) continue;
          throw error;
        }
        const previous = this.rejected.get(scope);
        const attempts = previous?.token === fingerprint(token) ? previous.attempts + 1 : 1;
        this.rejected.set(scope, { token: fingerprint(token), attempts,
          until: now() + (this.options.cooldownMs ?? 60_000) * 5 ** (attempts - 1) });
        // One atomic snapshot transitions in-flight -> rejected, including its count.
        // A restart must see either uncertainty or the final rejection, never neither.
        this.uncertain.delete(request);
        this.persist();
        throw error;
      }
    }
  }
}
