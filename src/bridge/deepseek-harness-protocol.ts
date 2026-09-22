import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";

/**
 * DSH Desktop 2.0.9 introduced two breaking changes on its loopback surface:
 * a mandatory signed browser-session cookie, and a Typert RPC dialect that
 * renamed every endpoint (`session.list` → `session/list`), wrapped arguments
 * in `{ args: { request | _request } }`, moved the event stream from
 * `/api/events.mux` to `/api/remote.mux`, and removed the `/api/respond`
 * receipt endpoint. Older builds (2.0.3 and earlier) keep the original
 * contract, and users may run either.
 *
 * This module keeps both dialects working from one adapter: the cookie is a
 * pure additive header that legacy builds ignore, and the endpoint/payload
 * dialect is detected once per connection and then cached.
 */

const CREDENTIALS_PATH = path.join(".dsh", ".credentials.yaml");
const COOKIE_PREFIX = "dsh-auth-";
const COOKIE_PAYLOAD_VERSION = 1;
const SECRET_PATTERN = /secret:\s*([A-Za-z0-9_-]{43})/u;
const SECRET_BYTES = 32;
const DEFAULT_COOKIE_MAX_AGE_DAYS = 30;

/** Which Harness RPC contract the connected host speaks. */
export type DeepSeekHarnessDialect = "legacy" | "typert";

export const DEEPSEEK_HARNESS_MUX_PATHS: Record<DeepSeekHarnessDialect, string> = {
  legacy: "/api/events.mux",
  typert: "/api/remote.mux",
};

/** Endpoint name per dialect; `null` means the host has no equivalent. */
const ENDPOINT_NAMES: Record<string, Record<DeepSeekHarnessDialect, string | null>> = {
  describeHost: { legacy: "host.describe", typert: null },
  listSessions: { legacy: "session.list", typert: "session/list" },
  createSession: { legacy: "session.create", typert: "session/create" },
  renameSession: { legacy: "session.rename", typert: "session/rename" },
  readHistory: { legacy: "session.history", typert: "session/page" },
  readModels: { legacy: "session.models", typert: "session/modelCatalog" },
  selectModel: { legacy: "session.selectModel", typert: "session/selectModel" },
  prompt: { legacy: "session.prompt", typert: "session/prompt" },
  cancelSession: { legacy: "session.cancel", typert: "session/cancel" },
  readPermission: { legacy: "session.permission", typert: "session/control" },
};

/** Capability names the adapter resolves to a dialect-specific endpoint. */
export type DeepSeekHarnessCapability = keyof typeof ENDPOINT_NAMES;

export function deepSeekHarnessEndpoint(
  capability: DeepSeekHarnessCapability,
  dialect: DeepSeekHarnessDialect,
): string | null {
  return ENDPOINT_NAMES[capability]?.[dialect] ?? null;
}

/**
 * Typert endpoints take a single `args` object whose field name depends on the
 * endpoint: `session/list` reads `_request`, the session mutators read
 * `request`, and catalog-style endpoints accept an empty `args` because they
 * declare no parameters.
 */
const TYPERT_EMPTY_ARGS_ENDPOINTS = new Set(["session/modelCatalog"]);

export function wrapTypertPayload(
  endpoint: string,
  request: Record<string, unknown>,
): { args: Record<string, unknown> } {
  if (TYPERT_EMPTY_ARGS_ENDPOINTS.has(endpoint)) return { args: {} };
  const field = endpoint === "session/list" ? "_request" : "request";
  return { args: { [field]: request } };
}

/**
 * Typert addresses a session through an `address` discriminated union rather
 * than a bare `sessionId`; subagent sessions use `childSessionId`.
 */
export function typertSessionAddress(
  sessionId: string,
  kind: "session" | "childSession" = "session",
): { address: { kind: "session"; sessionId: string } | { kind: "childSession"; childSessionId: string } } {
  return {
    address: kind === "session"
      ? { kind: "session", sessionId }
      : { kind: "childSession", childSessionId: sessionId },
  };
}

export type DeepSeekDesktopAuthDependencies = {
  readCredentials(): string;
  now(): number;
};

function defaultAuthDependencies(): DeepSeekDesktopAuthDependencies {
  const credentialsPath = path.join(os.homedir(), CREDENTIALS_PATH);
  return {
    readCredentials: () => fs.existsSync(credentialsPath)
      ? fs.readFileSync(credentialsPath, "utf8")
      : "",
    now: () => Date.now(),
  };
}

/** Canonical request authority; DSH keys the cookie name and audience on it. */
export function deepSeekHarnessAuthority(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
}

function cookieName(authority: string): string {
  return COOKIE_PREFIX + createHash("sha256").update(authority).digest("base64url");
}

function signature(secret: Buffer, body: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

/** Build the exact `Cookie` header value DSH Desktop accepts for one authority. */
export function buildDeepSeekHarnessSessionCookie(params: {
  authority: string;
  secret: Buffer;
  nowMs: number;
  maxAgeDays?: number;
}): string {
  const maxAgeMs = (params.maxAgeDays ?? DEFAULT_COOKIE_MAX_AGE_DAYS) * 24 * 60 * 60_000;
  const payload = {
    version: COOKIE_PAYLOAD_VERSION,
    authority: params.authority,
    issuedAt: params.nowMs,
    expiresAt: params.nowMs + maxAgeMs,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const value = `v1.${body}.${signature(params.secret, body).toString("base64url")}`;
  return `${cookieName(params.authority)}=${value}`;
}

/**
 * Resolve the cookie header for a Harness base URL, or null when the host has
 * no credential store — which is exactly the legacy case, where no cookie is
 * required and sending none keeps the original behaviour.
 */
export function resolveDeepSeekHarnessCookieHeader(
  baseUrl: string,
  dependencies: DeepSeekDesktopAuthDependencies = defaultAuthDependencies(),
): string | null {
  const authority = deepSeekHarnessAuthority(baseUrl);
  if (!authority) return null;
  let credentials: string;
  try {
    credentials = dependencies.readCredentials();
  } catch {
    return null;
  }
  const secretMatch = credentials.match(SECRET_PATTERN);
  if (!secretMatch?.[1]) return null;
  const secret = Buffer.from(secretMatch[1], "base64url");
  if (secret.byteLength !== SECRET_BYTES) return null;
  return buildDeepSeekHarnessSessionCookie({
    authority,
    secret,
    nowMs: dependencies.now(),
  });
}

/**
 * Classify the host dialect from a probe response against the Typert
 * slash-form endpoint. A Typert host serves that route, so a successful
 * `server-response` proves the new dialect; a legacy host has no such route
 * and answers 404. A Typert host without a valid cookie answers 401, which
 * also proves the route exists.
 */
export function classifyDeepSeekHarnessProbe(params: {
  status: number;
  body: string;
}): DeepSeekHarnessDialect | null {
  if (params.status === 404) return "legacy";
  if (params.status === 401 || params.status === 403) return "typert";
  if (params.status !== 200) return null;
  // A Typert host replies with its gateway envelope; either an accepted
  // result or a gateway-level rejection both prove the route is served.
  if (/"type"\s*:\s*"server-response"/u.test(params.body)) return "typert";
  if (/typert gateway|"code"\s*:\s*"gateway\//u.test(params.body)) return "typert";
  return "legacy";
}
