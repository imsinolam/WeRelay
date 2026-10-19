import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { BridgeSessionModelState } from "./bridge-types.ts";
import type { PiOwnerAdvertisement } from "./pi-owner-discovery.ts";
import { buildCliEnvironment, resolveSpawnTarget } from "./bridge-adapters.shared.ts";

/** Read-only client: no task selection, prompt, writer, or configuration changes. */
export async function readPiOwnerModels(owner: PiOwnerAdvertisement): Promise<BridgeSessionModelState> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(owner.socket);
    let buffer = "";
    let modelState: BridgeSessionModelState | undefined;
    let settled = false;
    const finish = (error?: Error, state?: BridgeSessionModelState) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); socket.destroy();
      if (error) reject(error); else if (state) resolve(state);
    };
    const timer = setTimeout(() => finish(new Error("读取 Pi 原窗口模型超时。")), 2000);
    socket.once("error", () => finish(new Error("Pi 原窗口暂时无法读取模型。")));
    socket.once("close", () => finish(new Error("Pi 原窗口模型连接已关闭。")));
    socket.once("connect", () => socket.write(JSON.stringify({ type: "hello", token: owner.token }) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 256 * 1024) { finish(new Error("Pi 模型列表过大。")); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const record = JSON.parse(line);
          if (record.token !== owner.token) { finish(new Error("Pi 模型来源验证失败。")); return; }
          if (record.type === "ready") socket.write(JSON.stringify({ id, type: "model_state", sessionId: record.sessionId, token: owner.token }) + "\n");
          if (record.type === "response" && record.id === id) {
            if (!record.ok || !record.modelState) finish(new Error("Pi 原窗口未提供模型目录。"));
            else {
              modelState = record.modelState;
              socket.write(JSON.stringify({ id: id + "-release", type: "release", sessionId: owner.sessionId, token: owner.token }) + "\n");
            }
          }
          if (record.type === "response" && record.id === id + "-release" && modelState) { finish(undefined, modelState); return; }
        } catch { finish(new Error("Pi 模型目录格式无效。")); return; }
      }
    });
  });
}

// Use the installed Pi SDK, not a second CLI session. Credentials remain inside
// the SDK; stdout contains only display metadata. No model/catalog network calls.
const CATALOG_SCRIPT = `
const sdk = await import(process.argv[1]);
const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
const labels = {off:'关闭推理',minimal:'极低',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高'};
const options = runtime.getAvailableSnapshot().slice(0,500).map(m => ({
 id: m.provider+'/'+m.id, label: m.name||m.id, group:m.provider,
 reasoningEffortOptions: !m.reasoning ? [] : Object.keys(labels).filter(l =>
 m.thinkingLevelMap?.[l] !== null && (!['xhigh','max'].includes(l)||m.thinkingLevelMap?.[l]!==undefined)
 ).map(id=>({id,label:labels[id]}))
}));
console.log(JSON.stringify({options,canChange:options.length>0}));
`;

export async function readPiInstalledModels(command: string): Promise<BridgeSessionModelState> {
  const env = { ...buildCliEnvironment("pi"), PI_OFFLINE: "1" };
  const target = resolveSpawnTarget(command, "pi", { env });
  let directory = path.dirname(fs.realpathSync(target.file));
  let entry: string | undefined;
  for (let depth = 0; depth < 7; depth++) {
    const manifest = path.join(directory, "package.json");
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"].includes(pkg.name)) {
        entry = ["dist/bundle/index.js", "dist/index.js"].map((file) => path.join(directory, file)).find((file) => fs.existsSync(file));
        break;
      }
    }
    directory = path.dirname(directory);
  }
  if (!entry) throw new Error("未找到 Pi 模型目录，请更新 Pi 或连接已打开的 Pi 窗口。");
  const output = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", CATALOG_SCRIPT, pathToFileURL(entry!).href], {
      env, cwd: path.parse(process.execPath).root, timeout: 8000, maxBuffer: 512 * 1024,
    }, (error, stdout) => error ? reject(new Error("读取 Pi 本机模型目录失败，请确认 Pi 已配置模型。")) : resolve(stdout));
  });
  return JSON.parse(output.trim()) as BridgeSessionModelState;
}

