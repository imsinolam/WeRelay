#!/usr/bin/env node

import os from "node:os";
import path from "node:path";

import {
  startWeRelayRelayServer,
} from "./relay-server.ts";

export type RelayServerCliOptions = {
  host: string;
  port: number;
  deviceId: string;
  deviceToken: string;
  allowNonLoopback: boolean;
  taskLinkStateFile: string;
  warmSnapshotFile: string | null;
};

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function isLoopbackRelayHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (!ipv4) {
    return false;
  }
  const octets = ipv4.slice(1).map(Number);
  return octets.every((value) => value >= 0 && value <= 255) && octets[0] === 127;
}

function isEnabled(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "");
}

export function formatRelayNonLoopbackWarning(host: string): string {
  return [
    "危险：Relay 正在监听非回环地址。",
    `监听地址：${host}`,
    "这会绕过推荐的 Nginx/Caddy HTTPS 边界；仅在已配置防火墙、TLS 和访问控制时使用。",
  ].join("\n");
}

export function parseRelayServerCliOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): RelayServerCliOptions {
  const host = readOption(args, "--host")?.trim() ||
    env.WERELAY_RELAY_HOST?.trim() ||
    "127.0.0.1";
  const allowNonLoopback = args.includes("--allow-non-loopback") ||
    isEnabled(env.WERELAY_RELAY_ALLOW_NON_LOOPBACK);
  if (!isLoopbackRelayHost(host) && !allowNonLoopback) {
    throw new Error(
      "Relay 默认只允许监听本机回环地址。若已做好防火墙、TLS 和访问控制，可显式添加 --allow-non-loopback。",
    );
  }
  const rawPort = readOption(args, "--port")?.trim() ||
    env.WERELAY_RELAY_PORT?.trim() ||
    "14396";
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Relay 监听端口无效。");
  }
  const deviceId = readOption(args, "--device-id")?.trim() ||
    env.WERELAY_RELAY_DEVICE_ID?.trim() ||
    "default";
  const deviceToken = env.WERELAY_RELAY_DEVICE_TOKEN?.trim() || "";
  if (!deviceToken) {
    throw new Error("缺少 WERELAY_RELAY_DEVICE_TOKEN，Relay 无法启动。");
  }
  const dataDir = env.WERELAY_DATA_DIR?.trim() || path.join(os.homedir(), ".werelay");
  const taskLinkStateFile = env.WERELAY_RELAY_TASK_LINK_STATE_FILE?.trim() ||
    path.join(dataDir, "relay-task-links.json");
  const configuredSnapshotFile = env.WERELAY_RELAY_WARM_SNAPSHOT_FILE?.trim();
  const warmSnapshotFile = configuredSnapshotFile?.toLowerCase() === "off"
    ? null
    : configuredSnapshotFile || path.join(dataDir, "relay-warm-snapshot.bin");
  return {
    host,
    port,
    deviceId,
    deviceToken,
    allowNonLoopback,
    taskLinkStateFile,
    warmSnapshotFile,
  };
}

export async function main(
  args: string[] = process.argv.slice(2),
): Promise<void> {
  const options = parseRelayServerCliOptions(args);
  if (options.allowNonLoopback && !isLoopbackRelayHost(options.host)) {
    process.stderr.write(`${formatRelayNonLoopbackWarning(options.host)}\n`);
  }
  const server = await startWeRelayRelayServer({
    host: options.host,
    port: options.port,
    deviceId: options.deviceId,
    deviceToken: options.deviceToken,
    taskLinkStateFile: options.taskLinkStateFile,
    ...(options.warmSnapshotFile
      ? { warmSnapshotFile: options.warmSnapshotFile }
      : {}),
    logger: (message) => process.stderr.write(`[WeRelay Relay] ${message}\n`),
  });
  process.stdout.write(
    `WeRelay Relay 已启动：http://${server.host}:${server.port}\n`,
  );

  let closing = false;
  const close = (signal: string) => {
    if (closing) {
      return;
    }
    closing = true;
    process.stdout.write(`收到 ${signal}，正在停止 WeRelay Relay。\n`);
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => close("SIGINT"));
  process.on("SIGTERM", () => close("SIGTERM"));
  process.on("SIGHUP", () => close("SIGHUP"));

  await new Promise<void>(() => undefined);
}

const isDirectRun = Boolean((import.meta as ImportMeta & { main?: boolean }).main);
if (isDirectRun) {
  void main();
}
