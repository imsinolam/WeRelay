#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import console from "node:console";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const options = parseArgs(process.argv.slice(2));
const server = options.server ?? process.env.WERELAY_GITHUB_PUBLISH_SERVER;
const identity = options.identity ?? process.env.WERELAY_GITHUB_PUBLISH_IDENTITY;
const remoteHelper = options.remoteHelper ?? process.env.WERELAY_GITHUB_REMOTE_HELPER;
const remoteRoot = options.remoteRoot ?? process.env.WERELAY_GITHUB_PUBLISH_ROOT ?? "~/werelay-github-relay";
const remoteHome = options.remoteHome ?? process.env.WERELAY_GITHUB_PUBLISH_HOME;

if (!server || !identity || !remoteHelper || !remoteHome || !remoteRoot || !options.message) {
  printHelp();
  process.exit(2);
}
if (/\s/.test(server) || server.startsWith("-")) {
  throw new Error("Invalid publishing server.");
}
if (!path.isAbsolute(identity)) {
  throw new Error("--identity must be an absolute local path.");
}
if (!isSafeRemotePath(remoteHelper)) {
  throw new Error("--remote-helper must be a safe server path.");
}
if (!isSafeRemotePath(remoteRoot)) {
  throw new Error("--remote-root must be a safe server path.");
}
if (remoteRoot.startsWith("~/") && (!remoteHome || !isSafeAbsoluteRemotePath(remoteHome))) {
  throw new Error("--remote-home is required when --remote-root starts with ~/.");
}
const resolvedRemoteRoot = remoteRoot.startsWith("~/")
  ? `${remoteHome}${remoteRoot.slice(1)}`
  : remoteRoot;
if (!isSafeAbsoluteRemotePath(resolvedRemoteRoot)) {
  throw new Error("Publishing root must resolve to an absolute server path.");
}
if (/\r|\n|\0/.test(options.message)) {
  throw new Error("Commit message must be a single line.");
}
if (!fs.existsSync(identity) || !fs.statSync(identity).isFile()) {
  throw new Error(`SSH identity does not exist: ${identity}`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-github-publish-"));
const snapshotDir = path.join(tempRoot, "snapshot");
const archivePath = path.join(tempRoot, "snapshot.tar.gz");
const releaseId = `${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${process.pid}`;
const remoteArchive = `${resolvedRemoteRoot.replace(/\/$/, "")}/incoming/werelay-snapshot-${releaseId}.tar.gz`;

try {
  run(process.execPath, [path.join(root, "scripts/check-public-safety.mjs")], { cwd: root });
  run(process.execPath, [path.join(root, "scripts/create-public-snapshot.mjs"), snapshotDir], { cwd: root });
  run("tar", ["--no-xattrs", "-czf", archivePath, "-C", snapshotDir, "."], {
    cwd: root,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });

  const archiveListing = run("tar", ["-tzf", archivePath], { cwd: root, capture: true });
  const forbiddenMetadata = archiveListing.split("\n").filter((entry) =>
    entry.split("/").some((part) => part === ".DS_Store" || part.startsWith("._")),
  );
  if (forbiddenMetadata.length > 0) {
    throw new Error(`Archive contains forbidden macOS metadata: ${forbiddenMetadata.join(", ")}`);
  }

  const sshArgs = [
    "-i", identity,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
  ];
  run("scp", [...sshArgs, archivePath, `${server}:${remoteArchive}`], { cwd: root });
  const encodedMessage = Buffer.from(options.message, "utf8").toString("base64url");
  const result = run("ssh", [
    ...sshArgs,
    server,
    `env WERELAY_GITHUB_PUBLISH_ROOT=${shellQuote(resolvedRemoteRoot)} ${shellQuote(remoteHelper)}`,
    remoteArchive,
    "--message-base64url",
    encodedMessage,
  ], { cwd: root, capture: true });
  process.stdout.write(result);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function run(command, args, { cwd, env, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() : "";
    throw new Error(`${command} failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return capture ? result.stdout : "";
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${arg}`);
    if (arg === "--server") parsed.server = value;
    else if (arg === "--identity") parsed.identity = path.resolve(value);
    else if (arg === "--remote-helper") parsed.remoteHelper = value;
    else if (arg === "--remote-home") parsed.remoteHome = value;
    else if (arg === "--remote-root") parsed.remoteRoot = value;
    else if (arg === "--message") parsed.message = value;
    else throw new Error(`Unknown argument: ${arg}`);
    index += 1;
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node scripts/publish-github-via-server.mjs \\
    --server user@publish.example.com \\
    --identity /absolute/path/to/ssh-key \\
    --remote-helper ~/bin/werelay-github-publish-remote \\
    --remote-home /home/example \\
    [--remote-root ~/werelay-github-relay] \\
    --message "fix: describe the public change"

The local machine only creates and uploads a privacy-reviewed snapshot.
GitHub fetch, commit, push, and verification must happen in the remote helper.`);
}

function isSafeRemotePath(value) {
  return /^~?\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..");
}

function isSafeAbsoluteRemotePath(value) {
  return /^\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
