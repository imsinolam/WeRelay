import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writePrivateFileAtomic } from "../utils/private-files.ts";

export function piDesktopConnectorPaths(dataDir = process.env.WERELAY_DATA_DIR?.trim() || path.join(os.homedir(), ".werelay")) {
  const directory = path.resolve(dataDir, "plugins", "pi-desktop-connector");
  return { directory, endpointFile: path.join(directory, "control.json") };
}

// Runs only inside Pi Desktop's official plugin host after the user installs
// and grants desktop.control. It forwards to the existing main-process owner.
function pluginSource(endpointFile: string): string {
  return `"use strict";
const endpointFile = ${JSON.stringify(endpointFile)};
` + String.raw`
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
let server, token;
const sessions = new Set();
function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error("WeRelay connector directory is unsafe");
  fs.chmodSync(directory, 0o700);
}
function id(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[:\x00-\x1f]/.test(value)) throw new Error("Invalid local Desktop session");
  return value;
}
function argumentsFor(operation, args) {
  if (!Array.isArray(args)) throw new Error("Invalid arguments");
  const input = args[0];
  switch (operation) {
    case "app/health": case "session/list":
      if (args.length) throw new Error("Unexpected arguments");
      return [];
    case "agent/getStatus": return [id(input)];
    case "session/get": {
      if (!input || typeof input !== "object") throw new Error("Invalid session query");
      const query = { id: id(input.id), messageLimit: 40, contentLimit: 8000 };
      if (input.messageLimit !== undefined) {
        if (!Number.isInteger(input.messageLimit) || input.messageLimit < 1 || input.messageLimit > 40) throw new Error("Invalid page size");
        query.messageLimit = input.messageLimit;
      }
      if (input.messageBefore !== undefined) {
        if (!Number.isSafeInteger(input.messageBefore) || input.messageBefore < 0) throw new Error("Invalid cursor");
        query.messageBefore = input.messageBefore;
      }
      return [query];
    }
    case "agent/prompt":
      if (!input || typeof input.content !== "string" || !input.content.trim() || input.content.length > 1000000) throw new Error("Invalid prompt");
      return [{ sessionId: id(input.sessionId), content: input.content }];
    case "agent/abort": return [{ sessionId: id(input && input.sessionId) }];
    case "session/rename":
      if (typeof args[1] !== "string" || !args[1].trim() || args[1].length > 256) throw new Error("Invalid title");
      return [id(input), args[1].trim()];
    case "session/create":
      if (!input || typeof input.projectPath !== "string" || !path.isAbsolute(input.projectPath) || input.projectPath.includes("\0")) throw new Error("Invalid project path");
      return [{ projectPath: input.projectPath }];
    default: throw new Error("Operation is not exposed by WeRelay");
  }
}
function respond(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(value === undefined ? "" : JSON.stringify(value));
}
async function handle(req, res) {
  if (req.headers.origin || req.headers.host !== "127.0.0.1:" + server.address().port) return respond(res, 403);
  const auth = Buffer.from(String(req.headers.authorization || ""));
  const expected = Buffer.from("Bearer " + token);
  if (auth.length !== expected.length || !crypto.timingSafeEqual(auth, expected)) return respond(res, 401);
  if (req.method !== "POST" || req.url !== "/mcp") return respond(res, 404);
  let body;
  try {
    const parts = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) return respond(res, 413);
      parts.push(chunk);
    }
    body = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!body || body.jsonrpc !== "2.0") throw new Error("Invalid envelope");
  } catch { return respond(res, 400); }
  const reply = (result) => respond(res, 200, { jsonrpc: "2.0", id: body.id, result });
  if (body.method === "initialize") {
    if (body.params?.protocolVersion !== "2025-03-26") return respond(res, 400);
    const session = crypto.randomBytes(24).toString("hex");
    sessions.add(session);
    if (sessions.size > 16) sessions.delete(sessions.values().next().value);
    res.setHeader("Mcp-Session-Id", session);
    return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "werelay-pi-desktop", version: "1" } });
  }
  if (!sessions.has(req.headers["mcp-session-id"]) || req.headers["mcp-protocol-version"] !== "2025-03-26") return respond(res, 404);
  if (body.method === "notifications/initialized") return respond(res, 202);
  if (body.method !== "tools/call" || body.params?.name !== "pi_desktop_invoke") return respond(res, 400);
  const operation = body.params.arguments?.operation;
  try {
    const args = argumentsFor(operation, body.params.arguments?.args);
    const result = await pi.desktop.invoke({ operation, args });
    return reply({ structuredContent: { operation, result } });
  } catch {
    // Never echo native errors, prompts or credentials into transport logs.
    return reply({ isError: true, content: [{ type: "text", text: "Desktop operation was not confirmed; check the original task." }] });
  }
}
async function onLoad() {
  if (server) return;
  if (process.platform === "win32") throw new Error("WeRelay Pi Desktop connector requires verifiable private POSIX credentials");
  await pi.desktop.listOperations(); // Official host enforces the user-granted permission.
  privateDirectory(path.dirname(endpointFile));
  token = crypto.randomBytes(32).toString("hex");
  server = http.createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) respond(res, 500); else res.end(); }); });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const temporary = endpointFile + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
    try {
      fs.writeFileSync(temporary, JSON.stringify({ active: true, url: "http://127.0.0.1:" + server.address().port + "/mcp", token, pid: process.pid }), { mode: 0o600, flag: "wx" });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, endpointFile);
    } finally { fs.rmSync(temporary, { force: true }); }
  } catch (error) { await onUnload(); throw error; }
}
async function onUnload() {
  const closing = server; server = undefined;
  if (closing) await new Promise(resolve => { closing.close(resolve); closing.closeAllConnections(); });
  sessions.clear();
  try { if (JSON.parse(fs.readFileSync(endpointFile, "utf8")).token === token) fs.rmSync(endpointFile); } catch {}
}
module.exports = { onLoad, onUnload };
`;
}

export function preparePiDesktopPlugin(dataDir?: string): { directory: string; endpointFile: string; message: string } {
  if (process.platform === "win32") throw new Error("Pi Desktop 连接插件暂仅支持 macOS/Linux。Windows 尚不能可靠验证本机凭据权限。");
  const paths = piDesktopConnectorPaths(dataDir);
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(paths.directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Pi Desktop 连接插件目录不安全，未覆盖。");
  const manifestFile = path.join(paths.directory, "manifest.json");
  if (fs.existsSync(manifestFile)) {
    const manifestStat = fs.lstatSync(manifestFile);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || JSON.parse(fs.readFileSync(manifestFile, "utf8")).id !== "local.werelay-connector") throw new Error("已有不同的 Pi Desktop 插件，未覆盖。");
  } else if (fs.readdirSync(paths.directory).length) throw new Error("Pi Desktop 插件目录已有其他内容，未覆盖。");
  writePrivateFileAtomic(manifestFile, JSON.stringify({
    schemaVersion: 1, id: "local.werelay-connector", name: "WeRelay · 手机连接", version: "1.0.0",
    description: "通过当前 Pi Desktop 主进程继续原任务；只开放任务列表、文字消息、新建、改名与停止。不重启、不授予免审权限。",
    main: "main.cjs", permissions: ["desktop.control"], engines: { piDesktop: ">=0.21.0" }, activationEvents: ["onStartup"],
  }, null, 2) + "\n");
  writePrivateFileAtomic(path.join(paths.directory, "main.cjs"), pluginSource(paths.endpointFile));
  return { ...paths, message: `Pi Desktop 尚未接入，连接插件已准备好。请在 Pi Desktop 的插件管理中选择“从目录安装”（或“加载开发插件”），选择 ${paths.directory}，确认桌面控制权限后，再在微信发送 /pi-d 或在网页重试。只需授权一次，不需要重启应用；未启动 Pi CLI、未创建替代任务。` };
}
