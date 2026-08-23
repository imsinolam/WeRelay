#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import console from "node:console";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { containsPersonalProductionDomain } from "./public-safety-rules.mjs";

const root = process.cwd();
const scanHistory = process.argv.includes("--history");
const allowedHomeNames = new Set([
  "alice",
  "bob",
  "demo",
  "example",
  "runner",
  "test",
  "tester",
  "user",
  "your-user",
]);
const binaryExtensions = new Set([
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mp3",
  ".mp4",
  ".node",
  ".pdf",
  ".png",
  ".wav",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);
const rasterImagePattern = /\.(?:gif|jpe?g|png|webp)$/i;
const reviewedRasterAssets = new Map([
  [
    "docs/images/werelay-four-panel-white-paper-boy-v10-handoff-comic.png",
    "9b1de869315893a4bfacf8bd3e10818207977f4731ab28861d7b37a8ab6dc4fe",
  ],
  [
    "docs/images/werelay-relationship-simple.svg",
    "ff53f9931a77cf17e8a402c43e20a94876cfe8e3d74f46099b399dce32fac1fc",
  ],
]);
const forbiddenFilePatterns = [
  { pattern: /(^|\/)\.env(?:\.|$)/, allow: /(^|\/)\.env\.example$/, reason: "environment file" },
  { pattern: /\.(?:key|mobileprovision|p12|pfx|pem)$/i, reason: "private key or certificate bundle" },
  { pattern: /(^|\/)(?:\.werelay|inbound-attachments|mobile-images)(\/|$)/, reason: "local runtime data" },
  { pattern: /(^|\/)(?:account\.json|context_tokens\.json|daemon-endpoint\.json|bridge-state\.json)$/i, reason: "runtime credential or state file" },
];
const secretPatterns = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g },
  { name: "OpenAI-style secret", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: "Slack token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g },
  { name: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "Bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/gi },
];

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitBuffer(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function addReviewedRasterFinding(relativePath, data, source, findings) {
  const expected = reviewedRasterAssets.get(relativePath);
  if (!expected) {
    findings.push(`${source}: forbidden raster image requires manual privacy review`);
    return;
  }
  const actual = sha256(data);
  if (actual !== expected) {
    findings.push(
      `${source}: reviewed raster image hash changed (expected ${expected}, got ${actual})`,
    );
  }
}

function listCandidateFiles() {
  const output = git([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  return output.split("\0").filter(Boolean).sort();
}

function isPrivateOrReservedIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function addTextFindings(text, source, findings) {
  for (const secret of secretPatterns) {
    secret.pattern.lastIndex = 0;
    if (secret.pattern.test(text)) {
      findings.push(`${source}: possible ${secret.name}`);
    }
  }

  const homePatterns = [
    { label: "macOS home path", pattern: /(?<![A-Za-z0-9._-])\/Users\/([^/\s"'`]+)/g },
    { label: "Windows home path", pattern: /(?<![A-Za-z0-9._-])C:\\Users\\([^\\\s"'`]+)/gi },
    { label: "escaped Windows home path", pattern: /(?<![A-Za-z0-9._-])C:\\\\Users\\\\([^\\\s"'`]+)/gi },
    { label: "Linux home path", pattern: /(?<![A-Za-z0-9._-])\/home\/([^/\s"'`]+)/g },
  ];
  for (const home of homePatterns) {
    for (const match of text.matchAll(home.pattern)) {
      const name = match[1]?.toLowerCase();
      // The scanner's own escaped-regex literal can look like a Windows username.
      if (name?.startsWith("([^")) {
        continue;
      }
      if (name && !allowedHomeNames.has(name) && name !== "用户名") {
        findings.push(`${source}: ${home.label} contains non-placeholder user "${match[1]}"`);
      }
    }
  }

  if (containsPersonalProductionDomain(text)) {
    findings.push(`${source}: personal production domain must use a reserved example domain`);
  }

  const seenAddresses = new Set();
  for (const match of text.matchAll(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g)) {
    const address = match[0];
    if (!isPrivateOrReservedIpv4(address) && !seenAddresses.has(address)) {
      seenAddresses.add(address);
      findings.push(`${source}: public IPv4 address ${address} is not from a documentation range`);
    }
  }
}

const findings = [];
for (const relativePath of listCandidateFiles()) {
  const absolutePath = path.join(root, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    continue;
  }
  if (stat.isFile() && rasterImagePattern.test(relativePath)) {
    addReviewedRasterFinding(
      relativePath,
      fs.readFileSync(absolutePath),
      relativePath,
      findings,
    );
  }
  for (const rule of forbiddenFilePatterns) {
    if (rule.pattern.test(relativePath) && !(rule.allow?.test(relativePath))) {
      findings.push(`${relativePath}: forbidden ${rule.reason}`);
    }
  }
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024 || binaryExtensions.has(path.extname(relativePath).toLowerCase())) {
    continue;
  }
  let text;
  try {
    text = fs.readFileSync(absolutePath, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue;
  addTextFindings(text, relativePath, findings);
}

if (scanHistory) {
  let history = "";
  try {
    history = git(["log", "--all", "--format=commit:%H", "-p", "--no-ext-diff", "--no-textconv"]);
  } catch (error) {
    findings.push(`git history scan failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  addTextFindings(history, "git history", findings);

  try {
    const historicalPaths = git([
      "log",
      "--all",
      "--format=",
      "--name-only",
      "--diff-filter=ACDMRTUXB",
    ]).split("\n").map((entry) => entry.trim()).filter(Boolean);
    for (const historicalPath of new Set(historicalPaths)) {
      if (rasterImagePattern.test(historicalPath)) {
        const expected = reviewedRasterAssets.get(historicalPath);
        if (!expected) {
          findings.push(
            `git history: ${historicalPath}: forbidden raster image requires manual privacy review`,
          );
        } else {
          const commits = git([
            "log",
            "--all",
            "--format=%H",
            "--",
            historicalPath,
          ]).split("\n").map((entry) => entry.trim()).filter(Boolean);
          for (const commit of new Set(commits)) {
            try {
              addReviewedRasterFinding(
                historicalPath,
                gitBuffer(["show", `${commit}:${historicalPath}`]),
                `git history: ${commit}:${historicalPath}`,
                findings,
              );
            } catch {
              // Deletion commits do not contain the path and need no blob review.
            }
          }
        }
      }
      for (const rule of forbiddenFilePatterns) {
        if (rule.pattern.test(historicalPath) && !(rule.allow?.test(historicalPath))) {
          findings.push(`git history: ${historicalPath}: forbidden ${rule.reason}`);
        }
      }
    }
  } catch (error) {
    findings.push(`git history filename scan failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const uniqueFindings = [...new Set(findings)].sort();
if (uniqueFindings.length > 0) {
  console.error(`Public safety check failed with ${uniqueFindings.length} finding(s):`);
  for (const finding of uniqueFindings) {
    console.error(`- ${finding}`);
  }
  if (scanHistory) {
    console.error("Create a clean public history or rewrite the affected history before publishing.");
  }
  process.exit(1);
}

console.log(`Public safety check passed (${listCandidateFiles().length} files${scanHistory ? ", including Git history" : ""}).`);
