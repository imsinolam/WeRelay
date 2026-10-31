import { createHash } from "node:crypto";

/**
 * Vendor push fan-out.
 *
 * Android has no shared system push channel in mainland China: every vendor
 * runs its own. This module keeps that seam in one place so the rest of the
 * daemon only asks "notify this user about this task", and a new vendor is an
 * additional provider instead of a change to task-flow code.
 *
 * Currently implemented: vivo (V-Push). Other vendors register the same shape
 * and need no changes outside this file.
 */

export type PushProviderId = "vivo";

export type PushRegistration = {
  provider: PushProviderId;
  /** Vendor device token. vivo calls it regid. */
  token: string;
  /** Vendor app id the token belongs to, when the vendor requires one. */
  appId?: string;
};

export type PushNotification = {
  title: string;
  content: string;
  /**
   * Opaque payload delivered to the app. Values must be strings and the total
   * size stays small because vendors cap it (vivo: 1024 characters).
   */
  data?: Record<string, string>;
  /** Notification slot to replace on update; keeps one row per task. */
  collapseKey?: string;
};

export type PushSendResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "invalid-token" | "rejected" | "transport"; message?: string };

export type PushProvider = {
  id: PushProviderId;
  /** True when this provider has usable credentials in the environment. */
  configured(): boolean;
  send(registration: PushRegistration, notification: PushNotification): Promise<PushSendResult>;
};

/** vpush API origin. See vivo 服务端API接口文档 (doc/362). */
const VIVO_PUSH_ORIGIN = "https://api-push.vivo.com.cn";
/** vivo caps titles at 40 and bodies at 100 characters (Java length). */
const VIVO_TITLE_MAX = 40;
const VIVO_CONTENT_MAX = 100;
/** Sent as `category`. Operating messages need no template review. */
const VIVO_CATEGORY_OPERATION = "CONTENT";
/** Message stays queued on vivo's side when the phone is offline. */
const VIVO_TIME_TO_LIVE_SECONDS = 3_600;
/** authToken is valid for a day; refresh well before that. */
const VIVO_AUTH_TTL_MS = 12 * 60 * 60_000;
/** Extra margin under the documented 1024-character clientCustomMap cap. */
const VIVO_CUSTOM_MAP_MAX = 1_000;

export type VivoCredentials = {
  appId: string;
  appKey: string;
  appSecret: string;
};

/** Reads vivo credentials from the environment; absent means "not configured". */
export function readVivoCredentials(
  env: NodeJS.ProcessEnv = process.env,
): VivoCredentials | null {
  const appId = env.WERELAY_VIVO_PUSH_APP_ID?.trim() ?? "";
  const appKey = env.WERELAY_VIVO_PUSH_APP_KEY?.trim() ?? "";
  const appSecret = env.WERELAY_VIVO_PUSH_APP_SECRET?.trim() ?? "";
  if (!appId || !appKey || !appSecret) return null;
  return { appId, appKey, appSecret };
}

export function truncatePushText(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * vivo signs with MD5(appId + appKey + timestamp + appSecret), lowercase hex.
 */
export function vivoAuthSign(params: {
  appId: string;
  appKey: string;
  timestamp: number;
  appSecret: string;
}): string {
  return createMd5(
    `${params.appId}${params.appKey}${String(params.timestamp)}${params.appSecret}`,
  );
}

function createMd5(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex");
}

export type VivoPushProviderOptions = {
  credentials: VivoCredentials | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export function createVivoPushProvider(options: VivoPushProviderOptions): PushProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let cachedAuth: { token: string; expiresAtMs: number } | null = null;

  const credentials = options.credentials;

  async function authenticate(): Promise<string | null> {
    if (!credentials) return null;
    const current = now();
    if (cachedAuth && cachedAuth.expiresAtMs > current) return cachedAuth.token;
    const timestamp = current;
    const body = {
      appId: Number(credentials.appId),
      appKey: credentials.appKey,
      timestamp,
      sign: vivoAuthSign({ ...credentials, timestamp }),
    };
    try {
      const response = await fetchImpl(`${VIVO_PUSH_ORIGIN}/message/auth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { result?: number; authToken?: string };
      if (payload.result !== 0 || !payload.authToken) return null;
      cachedAuth = { token: payload.authToken, expiresAtMs: current + VIVO_AUTH_TTL_MS };
      return cachedAuth.token;
    } catch {
      return null;
    }
  }

  return {
    id: "vivo",
    configured: () => credentials !== null,
    async send(registration, notification) {
      if (!credentials) return { ok: false, reason: "unsupported" };
      if (!registration.token) return { ok: false, reason: "invalid-token" };
      const authToken = await authenticate();
      if (!authToken) {
        return { ok: false, reason: "transport", message: "vivo push authentication failed" };
      }

      const body: Record<string, unknown> = {
        appId: Number(credentials.appId),
        regId: registration.token,
        notifyType: 4,
        title: truncatePushText(notification.title, VIVO_TITLE_MAX),
        content: truncatePushText(notification.content, VIVO_CONTENT_MAX),
        timeToLive: VIVO_TIME_TO_LIVE_SECONDS,
        // 1 opens the app; we never hand the vendor a URL we cannot vouch for.
        skipType: 1,
        category: VIVO_CATEGORY_OPERATION,
        requestId: `werelay-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      };
      const customMap = compactCustomMap(notification.data);
      if (customMap) body.clientCustomMap = customMap;
      if (notification.collapseKey) {
        const parsed = Number.parseInt(notification.collapseKey, 10);
        if (Number.isInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647) {
          body.notifyId = parsed;
        }
      }

      try {
        const response = await fetchImpl(`${VIVO_PUSH_ORIGIN}/message/send`, {
          method: "POST",
          headers: { "content-type": "application/json", authToken },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          return { ok: false, reason: "transport", message: `HTTP ${response.status}` };
        }
        const payload = (await response.json()) as { result?: number; desc?: string };
        if (payload.result === 0) return { ok: true };
        // 10302 means the token no longer maps to an installable device.
        if (payload.result === 10302) return { ok: false, reason: "invalid-token" };
        return { ok: false, reason: "rejected", message: payload.desc ?? String(payload.result) };
      } catch (error) {
        return {
          ok: false,
          reason: "transport",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function compactCustomMap(
  data: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!data) return null;
  const entries = Object.entries(data).filter(([, value]) => typeof value === "string");
  if (entries.length === 0) return null;
  const compact: Record<string, string> = {};
  let size = 0;
  for (const [key, value] of entries) {
    const cost = key.length + value.length;
    // Skip an oversized field but keep collecting the ones that still fit, so a
    // single long value cannot evict the routing data behind it.
    if (size + cost > VIVO_CUSTOM_MAP_MAX) continue;
    size += cost;
    compact[key] = value;
  }
  return Object.keys(compact).length > 0 ? compact : null;
}

export type PushRegistryOptions = {
  providers?: PushProvider[];
};

/**
 * Holds one registration per (device, provider) and fans a notification out to
 * every provider that can deliver it. Registrations are supplied by the app
 * after login, so storage stays in the caller's hands.
 */
export function createPushDispatch(options: PushRegistryOptions = {}) {
  const providers = new Map<PushProviderId, PushProvider>();
  for (const provider of options.providers ?? []) {
    providers.set(provider.id, provider);
  }

  return {
    /** Providers that currently have credentials; empty disables push entirely. */
    activeProviders(): PushProviderId[] {
      return [...providers.values()].filter((p) => p.configured()).map((p) => p.id);
    },
    async send(
      registrations: PushRegistration[],
      notification: PushNotification,
    ): Promise<PushSendResult[]> {
      const results: PushSendResult[] = [];
      for (const registration of registrations) {
        const provider = providers.get(registration.provider);
        if (!provider || !provider.configured()) {
          results.push({ ok: false, reason: "unsupported" });
          continue;
        }
        results.push(await provider.send(registration, notification));
      }
      return results;
    },
  };
}

export type PushDispatch = ReturnType<typeof createPushDispatch>;
