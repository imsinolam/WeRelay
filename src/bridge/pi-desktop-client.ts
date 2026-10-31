import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { piDesktopConnectorPaths } from "./pi-desktop-plugin.ts";

export const PI_DESKTOP_UNAVAILABLE = "Pi Desktop 尚未接入。请在电脑运行 werelay-pi-desktop-enable，按提示在 Pi Desktop 插件管理中安装并授权一次后重试；已有本机 MCP 控制接口也可直接连接。WeRelay 不会重启桌面端、启动 Pi CLI 或创建替代任务。";
const PI_DESKTOP_WINDOWS_UNAVAILABLE = "Pi Desktop 在 Windows 上暂不可接入：尚不能可靠验证本机凭据文件的访问权限。请在桌面原窗口继续操作；WeRelay 不会重启桌面端、放宽权限检查、启动 Pi CLI 或创建替代任务。";
export class PiDesktopUncertainError extends Error {}
export type PiDesktopEndpoint = { url: string; token: string; pid: number };
export type PiDesktopControl = { invoke(operation: string, args?: unknown[]): Promise<unknown> };
export function defaultPiDesktopEndpointFile(): string {
  return path.join(process.env.WERELAY_PI_DESKTOP_DATA_DIR?.trim() || path.join(os.homedir(), ".pi-desktop"), "mcp-control.json");
}

/** Credentials never leave the local host, logs, or adapter state. No application files are written. */
export function readPiDesktopEndpoint(
  file = defaultPiDesktopEndpointFile(),
  platform: NodeJS.Platform = process.platform,
): PiDesktopEndpoint {
  // POSIX mode bits do not prove a Windows file is private. Do not silently
  // accept it until the native control plane has a verifiable ACL contract.
  if (platform === "win32") throw new Error(PI_DESKTOP_WINDOWS_UNAVAILABLE);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error("unsafe endpoint");
    const value = JSON.parse(fs.readFileSync(fd, "utf8"));
    const url = new URL(value.url);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
        !url.port || url.pathname !== "/mcp" || url.search || url.hash || url.username || url.password ||
        value.active !== true || !/^[a-f0-9]{64}$/i.test(value.token) ||
        !Number.isInteger(value.pid) || value.pid <= 0) throw new Error("invalid endpoint");
    process.kill(value.pid, 0);
    return { url: url.href, token: value.token, pid: value.pid };
  } catch { throw new Error(PI_DESKTOP_UNAVAILABLE); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class PiDesktopClient implements PiDesktopControl {
  private endpoint?: PiDesktopEndpoint;
  private session?: string;
  private connecting?: Promise<void>;
  private nextId = 0;
  constructor(private readonly options: {
    endpointFile?: string;
    endpointFiles?: string[];
    timeoutMs?: number;
    /** Protocol-test seam; production always uses the secure file reader. */
    readEndpoint?: () => PiDesktopEndpoint;
  } = {}) {}

  private request(endpoint: PiDesktopEndpoint, body: unknown, session?: string): Promise<{ value: unknown; session?: string }> {
    // Native HTTP bypasses shell proxy configuration and never follows redirects.
    return new Promise((resolve, reject) => {
      const encoded = JSON.stringify(body);
      const req = http.request(endpoint.url, { method: "POST", agent: false, headers: {
        Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json",
        Accept: "application/json", "Content-Length": Buffer.byteLength(encoded),
        ...(session ? { "Mcp-Session-Id": session, "MCP-Protocol-Version": "2025-03-26" } : {}),
      } }, (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume(); reject(new PiDesktopUncertainError(PI_DESKTOP_UNAVAILABLE)); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) { req.destroy(new Error("Pi Desktop 响应过大，请缩小读取范围。")); return; }
          chunks.push(chunk);
        });
        res.on("error", () => reject(new PiDesktopUncertainError(PI_DESKTOP_UNAVAILABLE)));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            const sessionHeader = res.headers["mcp-session-id"];
            resolve({ value: text ? JSON.parse(text) : {}, session: typeof sessionHeader === "string" ? sessionHeader : undefined });
          } catch { reject(new PiDesktopUncertainError("Pi Desktop 返回了无法识别的响应，请检查原任务，未自动重试。")); }
        });
      });
      const timer = setTimeout(() => req.destroy(new Error("Pi Desktop 请求超时；发送结果尚未确认，请检查原任务后再决定是否重试。")), this.options.timeoutMs ?? 15_000);
      req.on("close", () => clearTimeout(timer));
      req.on("error", () => reject(new PiDesktopUncertainError("Pi Desktop 连接中断，操作结果尚未确认；请检查原任务，未自动重试。")));
      req.end(encoded);
    });
  }

  private async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let endpoint: PiDesktopEndpoint | undefined;
      if (this.options.readEndpoint) endpoint = this.options.readEndpoint();
      else {
        const files = this.options.endpointFiles ?? (this.options.endpointFile ? [this.options.endpointFile]
          : [piDesktopConnectorPaths().endpointFile, defaultPiDesktopEndpointFile()]);
        for (const file of files) {
          try { endpoint = readPiDesktopEndpoint(file); break; } catch { /* Try only the other known private local endpoint. */ }
        }
      }
      if (!endpoint) throw new Error(process.platform === "win32" ? PI_DESKTOP_WINDOWS_UNAVAILABLE : PI_DESKTOP_UNAVAILABLE);
      if (this.session && this.endpoint?.url === endpoint.url && this.endpoint.token === endpoint.token && this.endpoint.pid === endpoint.pid) return;
      this.session = undefined;
      const response = await this.request(endpoint, { jsonrpc: "2.0", id: ++this.nextId, method: "initialize", params: {
        protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "werelay", version: "1" },
      } });
      if (!response.session || record(response.value).error || record(record(response.value).result).protocolVersion !== "2025-03-26") throw new Error(PI_DESKTOP_UNAVAILABLE);
      await this.request(endpoint, { jsonrpc: "2.0", method: "notifications/initialized" }, response.session);
      this.endpoint = endpoint; this.session = response.session;
    })();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }

  async invoke(operation: string, args: unknown[] = []): Promise<unknown> {
    await this.connect();
    const id = ++this.nextId;
    let response;
    try {
      response = await this.request(this.endpoint!, { jsonrpc: "2.0", id, method: "tools/call", params: {
        name: "pi_desktop_invoke", arguments: { operation, args },
      } }, this.session);
    } catch (error) {
      this.session = undefined;
      // Even read timeouts must not cause a write to be replayed in a new MCP session.
      throw error;
    }
    const envelope = record(response.value);
    const result = record(envelope.result);
    let structured = result.structuredContent;
    if (structured === undefined && Array.isArray(result.content)) {
      try { structured = JSON.parse(String(record(result.content[0]).text)); } catch { /* fail closed below */ }
    }
    const value = record(structured);
    if (envelope.id !== id || value.truncated || (!envelope.error && !result.isError && (value.operation !== operation || !("result" in value)))) {
      throw new PiDesktopUncertainError("Pi Desktop 未返回有效的操作确认，请检查原任务，未自动重试。");
    }
    if (envelope.error || result.isError) {
      // A native operation can fail after enqueueing the prompt. Without an
      // explicit rejection receipt, never release its watch and replay it.
      if (operation === "agent/prompt") throw new PiDesktopUncertainError("Pi Desktop 未确认收到消息，请检查原任务；未自动重试，也未切换或新建替代任务。");
      throw new Error(`Pi Desktop 未能确认 ${operation} 操作，请在桌面端检查；未切换或新建替代任务。`);
    }
    return value.result;
  }
}
