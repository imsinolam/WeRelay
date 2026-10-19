import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import { isIP } from "node:net";
import {
  WERELAY_RELAY_SOCKET_MAX_PAYLOAD,
  WERELAY_RELAY_SOCKET_VERSION,
  WERELAY_RELAY_WEBSOCKET_PATH,
  normalizeWeRelayRelayBaseUrl,
  type WeRelayRelayCommandResponse,
} from "./relay-protocol.ts";

export function relayWebSocketUrl(baseUrl: string): string {
  const url = new URL(normalizeWeRelayRelayBaseUrl(baseUrl));
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol === "http:" && host !== "localhost" &&
    host !== "::1" && !(isIP(host) === 4 && host.startsWith("127."))) {
    throw new Error("明文 WebSocket 只允许连接回环地址，公网必须使用 HTTPS/WSS。");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = url.pathname.replace(/\/$/, "") + WERELAY_RELAY_WEBSOCKET_PATH;
  return url.toString();
}

export type RelaySocketSession = {
  respond: (response: WeRelayRelayCommandResponse) => Promise<void>;
  ready: () => void;
};

/** One bounded connection attempt; the caller owns reconnection/fallback. */
export async function runRelayWebSocketSession(options: {
  relayUrl: string;
  deviceId: string;
  deviceToken: string;
  signal: AbortSignal;
  capacity: () => number;
  onCommand: (value: unknown) => void;
  onSession: (session: RelaySocketSession | null) => void;
  onAlive: () => void;
  handshakeTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  responseTimeoutMs: number;
}): Promise<void> {
  const url = relayWebSocketUrl(options.relayUrl);
  // Resolve proxies using the HTTPS URL (not wss), respecting NO_PROXY.
  const proxy = getProxyForUrl(options.relayUrl);
  const socket = new WebSocket(url, {
    headers: {
      authorization: `Bearer ${options.deviceToken}`,
      "x-werelay-device-id": options.deviceId,
    },
    ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}),
    perMessageDeflate: false,
    maxPayload: WERELAY_RELAY_SOCKET_MAX_PAYLOAD,
    handshakeTimeout: options.handshakeTimeoutMs,
    followRedirects: false,
  });
  await new Promise<void>((resolve, reject) => {
    let welcomed = false;
    let finished = false;
    let lastAlive = Date.now();
    const pending = new Map<string, {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>();
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(handshakeTimer);
      clearInterval(heartbeatTimer);
      options.signal.removeEventListener("abort", aborted);
      options.onSession(null);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("WSS 响应尚未确认，改由 HTTPS 补交。"));
      }
      pending.clear();
      socket.terminate();
      if (error && !options.signal.aborted) reject(error); else resolve();
    };
    const send = (type: string, fields: Record<string, unknown> = {}) => {
      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > WERELAY_RELAY_SOCKET_MAX_PAYLOAD) {
        throw new Error("WSS 连接不可用或发送缓冲过大。");
      }
      socket.send(JSON.stringify({ version: WERELAY_RELAY_SOCKET_VERSION, type, ...fields }), (error) => {
        if (error) finish(new Error("WSS 写入失败。"));
      });
    };
    const session: RelaySocketSession = {
      ready: () => {
        if (!finished && welcomed) {
          try { send("ready", { capacity: options.capacity() }); }
          catch { finish(new Error("WSS 容量更新失败。")); }
        }
      },
      respond: (response) => new Promise<void>((accepted, rejected) => {
        if (finished || !welcomed) { rejected(new Error("WSS 连接已关闭。")); return; }
        if (pending.has(response.commandId)) { rejected(new Error("WSS 响应已经等待确认。")); return; }
        const timer = setTimeout(() => finish(new Error("WSS 响应确认超时。")), options.responseTimeoutMs);
        pending.set(response.commandId, { resolve: accepted, reject: rejected, timer });
        try { send("response", { response }); } catch { finish(new Error("WSS 响应写入失败。")); }
      }),
    };
    const aborted = () => finish();
    const handshakeTimer = setTimeout(() => finish(new Error("WSS 欢迎确认超时。")), options.handshakeTimeoutMs);
    const heartbeatTimer = setInterval(() => {
      if (!welcomed || finished) return;
      if (Date.now() - lastAlive > options.heartbeatTimeoutMs) {
        finish(new Error("WSS 心跳超时。"));
        return;
      }
      try { send("heartbeat"); } catch { finish(new Error("WSS 心跳发送失败。")); }
    }, options.heartbeatIntervalMs);
    socket.on("message", (data, isBinary) => {
      try {
        if (isBinary) throw new Error("不支持二进制设备帧。");
        const value = JSON.parse(data.toString()) as Record<string, unknown>;
        if (!value || value.version !== WERELAY_RELAY_SOCKET_VERSION) throw new Error("设备帧版本不匹配。");
        if (!welcomed) {
          if (value.type !== "hello") throw new Error("缺少设备欢迎确认。");
          welcomed = true;
          clearTimeout(handshakeTimer);
          options.onSession(session);
          session.ready();
        } else if (value.type === "command") {
          options.onCommand(value.command);
        } else if (value.type === "ack" && typeof value.commandId === "string") {
          const entry = pending.get(value.commandId);
          if (entry) { clearTimeout(entry.timer); pending.delete(value.commandId); entry.resolve(); }
        } else if (value.type !== "heartbeat-ack") {
          throw new Error("设备帧类型不正确。");
        }
        lastAlive = Date.now();
        options.onAlive();
      } catch { finish(new Error("WSS 设备协议不正确。")); }
    });
    socket.on("error", () => finish(new Error("WSS 连接失败。")));
    socket.on("close", () => finish(new Error("WSS 连接已断开。")));
    options.signal.addEventListener("abort", aborted, { once: true });
    if (options.signal.aborted) finish();
  });
}
