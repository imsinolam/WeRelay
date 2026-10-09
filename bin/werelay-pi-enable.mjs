#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("./pi-owner-extension.mjs", import.meta.url));
const directory = path.join(os.homedir(), ".pi", "agent", "extensions");
// Pi auto-discovers .js/.ts entries, not .mjs; the symlink target remains ESM.
const link = path.join(directory, "werelay-owner.js");
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const stat = fs.lstatSync(directory);
if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
  throw new Error("Pi 扩展目录不安全，未安装。");
}
let existing;
try { existing = fs.realpathSync(link); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (existing && existing !== fs.realpathSync(target)) throw new Error(`已存在不同的 Pi 扩展：${link}；未覆盖。`);
if (!existing) {
  // A dangling symlink is not ours; do not overwrite it.
  let dangling = false;
  try { fs.lstatSync(link); dangling = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (dangling) throw new Error(`已存在失效的 Pi 扩展链接：${link}；未覆盖。`);
  fs.symlinkSync(target, link);
}
process.stdout.write(`WeRelay 的 Pi 扩展已就绪。请在已打开的 Pi 原窗口输入 /reload；不会另开会话。\n`);
