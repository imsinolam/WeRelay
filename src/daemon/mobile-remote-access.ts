import fs from "node:fs";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { writePrivateFileAtomic } from "../utils/private-files.ts";
import {
  WERELAY_RELAY_CHECK_PATH,
  WERELAY_RELAY_PROTOCOL_VERSION,
} from "../relay/relay-protocol.ts";

export type MobileRemoteConfig = {
  relayUrl: string;
  deviceId: string;
  deviceToken: string;
};

export type MobileRemoteAccessView = {
  enabled: boolean;
  configured: boolean;
  showLocalLink: boolean;
  serverUrl: string;
  deviceId: string;
  hasToken: boolean;
  source: "saved" | "environment" | "none";
  status: "disabled" | "connecting" | "connected" | "disconnected" | "external";
};

function hasInvalidTokenCharacters(value: string): boolean {
  return /\s/.test(value) || Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

type SavedAccess = { version: 1; enabled?: boolean; showLocalLink?: boolean; config?: MobileRemoteConfig };

export class RemoteAccessError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

export function isPublicRelayAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 100 && b >= 64 && b <= 127 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && (b === 168 || b === 0) || a === 198 && (b === 18 || b === 19));
  }
  // Only global unicast IPv6; this also excludes mapped IPv4 and local scopes.
  return isIP(address) === 6 && /^[23]/i.test(address) &&
    !/^2001:(?:0{1,4}|db8):/i.test(address) && !/^2002:/i.test(address);
}

export function normalizeMobileRemoteUrl(input: unknown): string {
  if (typeof input !== "string" || input.length > 2048) {
    throw new RemoteAccessError("请填写服务器的 HTTPS 地址。");
  }
  let url: URL;
  try { url = new URL(input.trim()); } catch {
    throw new RemoteAccessError("地址格式不正确，例如 https://relay.example.com。");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/" || hostname === "localhost" ||
      hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
      isIP(hostname) && !isPublicRelayAddress(hostname)) {
    throw new RemoteAccessError("请使用公网 HTTPS 服务器地址，不要填写本机地址、内网地址、路径或带密码的链接。");
  }
  return url.origin;
}

/**
 * A bounded authenticated probe, not a general-purpose proxy. DNS is checked
 * and pinned for this request; redirects and arbitrary response data are ignored.
 */
export async function checkMobileRemoteConnection(config: MobileRemoteConfig): Promise<void> {
  const base = normalizeMobileRemoteUrl(config.relayUrl);
  const url = new URL(base + WERELAY_RELAY_CHECK_PATH);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(
          new RemoteAccessError("连接超时，请确认服务器已启动且 HTTPS 地址可以访问。"),
        ), { once: true });
      }),
    ]);
    if (!addresses.length || addresses.some((entry) => !isPublicRelayAddress(entry.address))) {
      throw new RemoteAccessError("服务器地址指向本机或内网，请使用公网 HTTPS 地址。");
    }
    const address = addresses[0]!;
    await new Promise<void>((resolve, reject) => {
      const request = https.request(url, {
        method: "GET",
        signal: controller.signal,
        // Pin the checked IP while retaining normal hostname/certificate validation.
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
        headers: {
          authorization: `Bearer ${config.deviceToken}`,
          "x-werelay-device-id": config.deviceId,
          accept: "application/json",
        },
      }, (response) => {
        const status = response.statusCode;
        if (status === 401 || status === 403) {
          response.destroy();
          reject(new RemoteAccessError("连接密钥或设备标识不匹配，请核对服务器配置后重试。"));
          return;
        }
        if (status !== 200) {
          response.destroy();
          reject(new RemoteAccessError(status === 404
            ? "服务器尚不支持连接检查，请先将 Relay 服务器升级到支持此功能的版本。"
            : "服务器没有通过检查，请确认地址正确、HTTPS 正常且 Relay 已启动。"));
          return;
        }
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
          if (body.length > 4096) response.destroy(new Error("response too large"));
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const payload = JSON.parse(body);
            if (payload.ok !== true || payload.protocolVersion !== WERELAY_RELAY_PROTOCOL_VERSION) {
              throw new Error("invalid relay");
            }
            resolve();
          } catch {
            reject(new RemoteAccessError("这个地址不是兼容的 Relay 服务，请核对服务器部署。"));
          }
        });
      });
      request.on("error", reject);
      request.end();
    });
  } catch (error) {
    if (error instanceof RemoteAccessError) throw error;
    throw new RemoteAccessError(controller.signal.aborted
      ? "连接超时，请确认服务器已启动且 HTTPS 地址可以访问。"
      : "无法安全连接服务器，请检查网络、域名和 HTTPS 证书。");
  } finally {
    clearTimeout(timer);
  }
}

export class MobileRemoteAccess {
  private saved?: SavedAccess;
  private busy = false;
  private connectionStatus: MobileRemoteAccessView["status"] = "connecting";

  constructor(private readonly options: {
    stateFile: string;
    environmentConfig?: MobileRemoteConfig | null;
    legacyPublicUrl?: string;
    check?: (config: MobileRemoteConfig) => Promise<void>;
    apply: (config: MobileRemoteConfig | null) => Promise<void>;
  }) {
    if (fs.existsSync(options.stateFile)) {
      try {
        const value = JSON.parse(fs.readFileSync(options.stateFile, "utf8")) as SavedAccess;
        if (value.version !== 1 ||
            (value.enabled !== undefined && typeof value.enabled !== "boolean") ||
            (value.showLocalLink !== undefined && typeof value.showLocalLink !== "boolean") ||
            (value.enabled === undefined && value.showLocalLink === undefined) ||
            value.enabled && !value.config ||
            value.config && (
              typeof value.config.relayUrl !== "string" ||
              typeof value.config.deviceId !== "string" ||
              typeof value.config.deviceToken !== "string"
            )) throw new Error("invalid config");
        if (value.config && value.enabled) {
          value.config.relayUrl = normalizeMobileRemoteUrl(value.config.relayUrl);
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(value.config.deviceId) ||
              value.config.deviceToken.length < 16 || value.config.deviceToken.length > 1024 ||
              hasInvalidTokenCharacters(value.config.deviceToken)) throw new Error("invalid config");
        }
        this.saved = value;
      } catch {
        throw new RemoteAccessError("远程访问配置无法读取，已停止启用远程连接。请在电脑上检查配置文件。");
      }
    }
  }

  activeConfig(): MobileRemoteConfig | null {
    return typeof this.saved?.enabled === "boolean"
      ? this.saved.enabled ? this.saved.config ?? null : null
      : this.options.environmentConfig ?? null;
  }

  publicUrl(): string | undefined {
    return this.activeConfig()?.relayUrl ??
      (typeof this.saved?.enabled !== "boolean" ? this.options.legacyPublicUrl?.trim() || undefined : undefined);
  }

  setConnectionStatus(status: "connecting" | "connected" | "disconnected"): void {
    this.connectionStatus = status;
  }

  view(): MobileRemoteAccessView {
    const config = this.saved?.config ?? this.options.environmentConfig;
    const publicUrl = this.publicUrl();
    return {
      enabled: Boolean(publicUrl),
      configured: Boolean(config || this.options.legacyPublicUrl?.trim()),
      showLocalLink: this.saved?.showLocalLink ?? false,
      serverUrl: config?.relayUrl ?? publicUrl ?? "",
      deviceId: config?.deviceId ?? "default",
      hasToken: Boolean(config?.deviceToken),
      source: typeof this.saved?.enabled === "boolean" ? "saved" : config || publicUrl ? "environment" : "none",
      status: !publicUrl ? "disabled" : this.activeConfig() ? this.connectionStatus : "external",
    };
  }

  private configFromInput(input: Record<string, unknown>): MobileRemoteConfig {
    const relayUrl = normalizeMobileRemoteUrl(input.serverUrl);
    const deviceId = typeof input.deviceId === "string" ? input.deviceId.trim() : "default";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) {
      throw new RemoteAccessError("设备标识只能使用英文字母、数字、横线和下划线。");
    }
    const previous = this.saved?.config ?? this.options.environmentConfig;
    const providedToken = typeof input.deviceToken === "string" ? input.deviceToken.trim() : "";
    const deviceToken = providedToken || (previous?.relayUrl.replace(/\/+$/, "") === relayUrl &&
      previous.deviceId === deviceId ? previous.deviceToken : "");
    if (deviceToken.length < 16 || deviceToken.length > 1024 || hasInvalidTokenCharacters(deviceToken)) {
      throw new RemoteAccessError("请填写服务器的连接密钥（至少 16 个字符），不是网页登录密码。更换服务器或设备时必须重新填写。");
    }
    return { relayUrl, deviceId, deviceToken };
  }

  async change(input: Record<string, unknown>, checkOnly = false): Promise<MobileRemoteAccessView> {
    if (this.busy) throw new RemoteAccessError("正在处理上一项配置，请稍后再试。", 409);
    if (input.showLocalLink !== undefined && typeof input.showLocalLink !== "boolean") {
      throw new RemoteAccessError("请选择是否显示本机链接。");
    }
    if (input.enabled === undefined && typeof input.showLocalLink === "boolean" && !checkOnly) {
      const saved: SavedAccess = { ...this.saved, version: 1, showLocalLink: input.showLocalLink };
      writePrivateFileAtomic(this.options.stateFile, JSON.stringify(saved));
      this.saved = saved;
      return this.view();
    }
    if (typeof input.enabled !== "boolean") throw new RemoteAccessError("请选择是否启用远端服务器。");
    this.busy = true;
    try {
      const next = input.enabled ? this.configFromInput(input) : null;
      if (next) await (this.options.check ?? checkMobileRemoteConnection)(next);
      if (checkOnly) {
        if (!next) throw new RemoteAccessError("请先填写要检查的服务器。");
        return this.view();
      }
      const previous = this.saved;
      const previousActive = this.activeConfig();
      const saved: SavedAccess = {
        version: 1, enabled: input.enabled,
        showLocalLink: typeof input.showLocalLink === "boolean" ? input.showLocalLink : previous?.showLocalLink ?? false,
        ...(next ? { config: next } : previous?.config ? { config: previous.config } :
          previousActive ? { config: previousActive } : {}),
      };
      // Commit the private configuration before changing the live connection.
      writePrivateFileAtomic(this.options.stateFile, JSON.stringify(saved));
      this.saved = saved;
      this.connectionStatus = "connecting";
      try {
        await this.options.apply(next);
      } catch {
        this.saved = previous;
        if (previous) writePrivateFileAtomic(this.options.stateFile, JSON.stringify(previous));
        else fs.rmSync(this.options.stateFile, { force: true });
        try { await this.options.apply(previousActive); } catch { /* Report the failure, never a success. */ }
        throw new RemoteAccessError("新配置未能启用，已还原保存的配置；连接是否恢复请以状态为准。请重试或检查电脑上的服务。", 503);
      }
      return this.view();
    } finally {
      this.busy = false;
    }
  }
}
