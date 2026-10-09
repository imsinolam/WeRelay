#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const useActive = args.length === 1 && args[0] === "--active";
let base = args.length === 2 && args[0] === "--base" ? args[1] : "";
if (!useActive && !/^[0-9a-f]{40}$/i.test(base)) {
  console.error("用法：npm run baseline:check -- --active，或 --base <负责人确认的完整基线 SHA>");
  process.exit(2);
}

function git(...gitArgs) {
  return execFileSync("git", gitArgs, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

try {
  const root = git("rev-parse", "--show-toplevel");
  // Git knows the repository-relative cwd even when Windows exposes path aliases.
  if (git("rev-parse", "--show-prefix")) throw new Error("请在目标 worktree 根目录执行");
  if (useActive) {
    try {
      base = git("show-ref", "--verify", "--hash", "refs/werelay/active-baseline");
    } catch {
      throw new Error("尚未设置当前基线；请由体验整合负责人安装共享守卫并登记已部署候选的完整 SHA");
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (pkg.name !== "werelay" || !/^0\.\d+\.\d+(?:-|$)/.test(pkg.version) ||
      !/github\.com\/imsinolam\/WeRelay(?:\.git)?$/.test(pkg.repository?.url ?? "")) {
    throw new Error("当前工作树不是 WeRelay 0.x 主线；旧 DeskRelay/2.x 只能提取功能补丁");
  }
  git("cat-file", "-e", `${base}^{commit}`);
  const head = git("rev-parse", "HEAD");
  let ancestor;
  try {
    ancestor = git("merge-base", base, head);
  } catch {
    throw new Error(`当前工作树与现行基线没有共同历史：base=${base} HEAD=${head}；只能在现行基线的新 worktree 中移植补丁`);
  }
  if (ancestor !== base) {
    throw new Error(`起点不是负责人确认的当前基线后代：base=${base} HEAD=${head}；请从当前主线新建独立 worktree 并移植改动`);
  }
  console.log(`基线通过：${pkg.name}@${pkg.version} HEAD=${head} base=${base}`);
} catch (error) {
  console.error(`基线检查失败：${error.message}`);
  process.exitCode = 1;
}
