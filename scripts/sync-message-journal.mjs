#!/usr/bin/env node
// Only this allowlist may cross from the private plugin directory into a package.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
export const files = ["src/parser.mjs", "src/scanner.mjs", "panel/core.mjs", "panel/index.html", "panel/app.js", "panel/panel.css"];
const checkOnly = process.argv.includes("--check");
let source = checkOnly ? undefined : process.env.MESSAGE_JOURNAL_SOURCE;
if (!checkOnly && !source) {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    source = path.resolve(common, "../..", "magpie-message-journal");
  } catch { /* Installed packages build from the reviewed snapshot. */ }
}
const target = path.join(root, "vendor/message-journal");
let available = false;
if (source) {
  try { await fs.access(path.join(source, "package.json")); available = true; }
  catch { if (process.env.MESSAGE_JOURNAL_SOURCE) throw new Error("指定的消息日历源码不存在。"); }
}
if (available) {
  // Read every input before writing; refuse plugins without the shared host contract.
  const inputs = await Promise.all(files.map(async name => [name, await fs.readFile(path.join(source, name), "utf8")]));
  if (!inputs.find(([name]) => name === "panel/app.js")[1].includes("window.JournalHost")) throw new Error("消息日历缺少共享宿主接口，请先更新插件。");
  const hashes = {};
  for (const [name, text] of inputs) {
    hashes[name] = createHash("sha256").update(text).digest("hex");
    await fs.mkdir(path.dirname(path.join(target, name)), { recursive: true });
    await fs.writeFile(path.join(target, name), text);
  }
  await fs.writeFile(path.join(target, "provenance.json"), JSON.stringify({ schemaVersion: 1, source: "magpie-message-journal", files: hashes }, null, 2) + "\n");
}
const manifest = JSON.parse(await fs.readFile(path.join(target, "provenance.json"), "utf8"));
for (const name of files) {
  const text = await fs.readFile(path.join(target, name));
  if (createHash("sha256").update(text).digest("hex") !== manifest.files[name]) throw new Error("消息日历快照校验失败：" + name);
}
console.error(available ? "已同步消息日历共享源码（不含私人索引和分类）。" : "使用已校验的消息日历源码快照。");
