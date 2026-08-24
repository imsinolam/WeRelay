import fs from "node:fs";
import path from "node:path";

import {
  WERELAY_RELAY_POLL_PATH,
  WERELAY_RELAY_PROTOCOL_VERSION,
  WERELAY_RELAY_RESPONSE_BODY_LIMIT,
  WERELAY_RELAY_RESPONSE_PATH,
  normalizeWeRelayRelayBaseUrl,
  type WeRelayRelayCommand,
  type WeRelayRelayCommandResponse,
  type WeRelayRelayHeaderMap,
} from "./relay-protocol.ts";
import { writePrivateFileAtomic } from "../utils/private-files.ts";

const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 15_000;
const JOURNAL_MAX_ENTRIES = 64;

export type StartWeRelayRelayClientOptions = {
  relayUrl: string;
  deviceId: string;
  deviceToken: string;
  localBaseUrl: string;
  localPrewarmToken?: string;
  journalFile?: string;
  logger?: (message: string) => void;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
};

export type WeRelayRelayClientHandle = {
  close: () => Promise<void>;
  done: Promise<void>;
};

type JournalState = {
  version: 1;
  entries: Array<{
    commandId: string;
    completedAt: string;
    response: WeRelayRelayCommandResponse;
  }>;
};

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function isRelayCommand(value: unknown): value is WeRelayRelayCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record.protocolVersion !== WERELAY_RELAY_PROTOCOL_VERSION ||
    typeof record.id !== "string" ||
    typeof record.deviceId !== "string" ||
    typeof record.createdAtMs !== "number" ||
    typeof record.expiresAtMs !== "number" ||
    !record.request ||
    typeof record.request !== "object" ||
    Array.isArray(record.request)
  ) {
    return false;
  }
  const request = record.request as Record<string, unknown>;
  return (
    request.method === "GET" ||
    request.method === "POST" ||
    request.method === "PUT" ||
    request.method === "PATCH" ||
    request.method === "DELETE"
  ) &&
    typeof request.path === "string" &&
    request.path.startsWith("/api/") &&
    Boolean(request.headers) &&
    typeof request.headers === "object" &&
    !Array.isArray(request.headers) &&
    typeof request.clientAddress === "string" &&
    (request.forwardedProto === "http" || request.forwardedProto === "https") &&
    (request.bodyBase64 === undefined || typeof request.bodyBase64 === "string");
}

function responseHeaders(response: Response): WeRelayRelayHeaderMap {
  const result: WeRelayRelayHeaderMap = {};
  for (const name of [
    "content-type",
    "cache-control",
    "location",
    "retry-after",
  ]) {
    const value = response.headers.get(name);
    if (value) {
      result[name] = value;
    }
  }
  const getSetCookie = (response.headers as Headers & {
    getSetCookie?: () => string[];
  }).getSetCookie;
  const setCookies = typeof getSetCookie === "function"
    ? getSetCookie.call(response.headers)
    : [];
  if (setCookies.length > 0) {
    result["set-cookie"] = setCookies;
  } else {
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      result["set-cookie"] = setCookie;
    }
  }
  return result;
}

function buildJsonErrorResponse(
  commandId: string,
  statusCode: number,
  message: string,
): WeRelayRelayCommandResponse {
  return {
    protocolVersion: WERELAY_RELAY_PROTOCOL_VERSION,
    commandId,
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    bodyBase64: Buffer.from(JSON.stringify({ error: message })).toString("base64"),
  };
}

export class WeRelayRelayCommandJournal {
  private readonly stateFile?: string;
  private readonly entries = new Map<string, WeRelayRelayCommandResponse>();
  private readonly order: string[] = [];

  constructor(stateFile?: string) {
    this.stateFile = stateFile;
    this.load();
  }

  get(commandId: string): WeRelayRelayCommandResponse | null {
    return this.entries.get(commandId) ?? null;
  }

  save(response: WeRelayRelayCommandResponse): void {
    if (this.entries.has(response.commandId)) {
      this.entries.set(response.commandId, response);
      this.persist();
      return;
    }
    this.entries.set(response.commandId, response);
    this.order.push(response.commandId);
    while (this.order.length > JOURNAL_MAX_ENTRIES) {
      const removed = this.order.shift();
      if (removed) {
        this.entries.delete(removed);
      }
    }
    this.persist();
  }

  private load(): void {
    if (!this.stateFile) {
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as JournalState;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        return;
      }
      for (const entry of parsed.entries.slice(-JOURNAL_MAX_ENTRIES)) {
        if (
          typeof entry?.commandId !== "string" ||
          !entry.response ||
          entry.response.commandId !== entry.commandId
        ) {
          continue;
        }
        this.entries.set(entry.commandId, entry.response);
        this.order.push(entry.commandId);
      }
    } catch {
      // Missing or invalid journals are ignored.
    }
  }

  private persist(): void {
    if (!this.stateFile) {
      return;
    }
    const state: JournalState = {
      version: 1,
      entries: this.order.map((commandId) => ({
        commandId,
        completedAt: new Date().toISOString(),
        response: this.entries.get(commandId) as WeRelayRelayCommandResponse,
      })),
    };
    writePrivateFileAtomic(this.stateFile, `${JSON.stringify(state)}\n`);
  }
}

async function executeRelayCommand(
  command: WeRelayRelayCommand,
  options: {
    localBaseUrl: string;
    localPrewarmToken?: string;
    fetchImpl: typeof fetch;
  },
): Promise<WeRelayRelayCommandResponse> {
  let localUrl: URL;
  try {
    localUrl = new URL(command.request.path, `${options.localBaseUrl}/`);
  } catch {
    return buildJsonErrorResponse(command.id, 400, "请求地址无效。");
  }
  const expectedOrigin = new URL(`${options.localBaseUrl}/`).origin;
  if (localUrl.origin !== expectedOrigin || !localUrl.pathname.startsWith("/api/")) {
    return buildJsonErrorResponse(command.id, 403, "这个请求不属于 WeRelay 移动接口。");
  }
  if (command.expiresAtMs <= Date.now()) {
    return buildJsonErrorResponse(command.id, 408, "请求已经过期，请重新操作。");
  }

  const headers = new Headers(command.request.headers);
  const prewarmRequest = headers.get("x-werelay-prewarm") === "1";
  headers.delete("x-werelay-prewarm");
  if (prewarmRequest) {
    if (!options.localPrewarmToken) {
      return buildJsonErrorResponse(command.id, 403, "电脑未启用 Relay 预热授权。");
    }
    headers.set("x-werelay-relay-prewarm", options.localPrewarmToken);
  }
  headers.set("x-real-ip", command.request.clientAddress);
  headers.set("x-forwarded-proto", command.request.forwardedProto);
  headers.set("x-werelay-relay", "1");
  let body: Buffer | undefined;
  if (command.request.bodyBase64) {
    try {
      body = Buffer.from(command.request.bodyBase64, "base64");
    } catch {
      return buildJsonErrorResponse(command.id, 400, "请求内容格式不正确。");
    }
  }

  try {
    const response = await options.fetchImpl(localUrl, {
      method: command.request.method,
      headers,
      ...(body && command.request.method !== "GET" ? { body } : {}),
      redirect: "manual",
    });
    const responseBody = Buffer.from(await response.arrayBuffer());
    if (responseBody.length > WERELAY_RELAY_RESPONSE_BODY_LIMIT) {
      return buildJsonErrorResponse(command.id, 502, "电脑返回的内容过大。");
    }
    return {
      protocolVersion: WERELAY_RELAY_PROTOCOL_VERSION,
      commandId: command.id,
      statusCode: response.status,
      headers: responseHeaders(response),
      ...(responseBody.length > 0
        ? { bodyBase64: responseBody.toString("base64") }
        : {}),
    };
  } catch {
    return buildJsonErrorResponse(
      command.id,
      502,
      "电脑端移动服务暂时不可用，请稍后重试。",
    );
  }
}

async function postCommandResponse(
  response: WeRelayRelayCommandResponse,
  options: {
    relayUrl: string;
    deviceId: string;
    deviceToken: string;
    fetchImpl: typeof fetch;
    signal: AbortSignal;
  },
): Promise<void> {
  const result = await options.fetchImpl(
    `${options.relayUrl}${WERELAY_RELAY_RESPONSE_PATH}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.deviceToken}`,
        "content-type": "application/json",
        "x-werelay-device-id": options.deviceId,
      },
      body: JSON.stringify(response),
      signal: options.signal,
    },
  );
  if (!result.ok) {
    throw new Error(`Relay 返回 ${result.status}`);
  }
}

export function startWeRelayRelayClient(
  options: StartWeRelayRelayClientOptions,
): WeRelayRelayClientHandle {
  const relayUrl = normalizeWeRelayRelayBaseUrl(options.relayUrl);
  const localBaseUrl = normalizeWeRelayRelayBaseUrl(options.localBaseUrl);
  const deviceId = options.deviceId.trim();
  const deviceToken = options.deviceToken.trim();
  if (!deviceId || !deviceToken) {
    throw new Error("WeRelay Relay 缺少设备 ID 或设备密钥。");
  }
  const logger = options.logger ?? (() => undefined);
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseRetryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const journal = new WeRelayRelayCommandJournal(options.journalFile);
  const abortController = new AbortController();

  const done = (async () => {
    let consecutiveFailures = 0;
    while (!abortController.signal.aborted) {
      try {
        const pollResponse = await fetchImpl(
          `${relayUrl}${WERELAY_RELAY_POLL_PATH}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${deviceToken}`,
              "content-type": "application/json",
              "x-werelay-device-id": deviceId,
            },
            body: "{}",
            signal: abortController.signal,
          },
        );
        if (pollResponse.status === 204) {
          consecutiveFailures = 0;
          continue;
        }
        if (pollResponse.status === 401) {
          throw new Error("设备认证失败，请检查 Relay 设备密钥。");
        }
        if (!pollResponse.ok) {
          throw new Error(`Relay 暂时不可用（${pollResponse.status}）。`);
        }
        const commandValue = await pollResponse.json();
        if (!isRelayCommand(commandValue) || commandValue.deviceId !== deviceId) {
          throw new Error("Relay 返回了无法识别的请求。");
        }
        const command = commandValue;
        let commandResponse = command.request.method === "GET"
          ? null
          : journal.get(command.id);
        if (!commandResponse) {
          commandResponse = await executeRelayCommand(command, {
            localBaseUrl,
            ...(options.localPrewarmToken
              ? { localPrewarmToken: options.localPrewarmToken }
              : {}),
            fetchImpl,
          });
          if (command.request.method !== "GET") {
            journal.save(commandResponse);
          }
        }
        await postCommandResponse(commandResponse, {
          relayUrl,
          deviceId,
          deviceToken,
          fetchImpl,
          signal: abortController.signal,
        });
        if (consecutiveFailures > 0) {
          logger("WeRelay 公网连接已恢复。");
        }
        consecutiveFailures = 0;
      } catch (error) {
        if (abortController.signal.aborted) {
          break;
        }
        consecutiveFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        logger(`WeRelay 公网连接异常：${message}`);
        const retryDelayMs = Math.min(
          MAX_RETRY_DELAY_MS,
          baseRetryDelayMs * Math.max(1, 2 ** Math.min(4, consecutiveFailures - 1)),
        );
        await delay(retryDelayMs, abortController.signal);
      }
    }
  })();

  return {
    done,
    close: async () => {
      abortController.abort();
      await done;
    },
  };
}
