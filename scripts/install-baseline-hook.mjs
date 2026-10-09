#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const base = args.length === 2 && args[0] === "--base" ? args[1] : "";
if (!/^[0-9a-f]{40}$/i.test(base)) {
  console.error("用法：node scripts/install-baseline-hook.mjs --base <已成功部署候选的完整 SHA>");
  process.exit(2);
}

function git(...gitArgs) {
  return execFileSync("git", gitArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const hook = `#!/bin/sh
# WeRelay shared worktree baseline guard; installed by scripts/install-baseline-hook.mjs.
exec node "$(dirname "$0")/werelay-baseline-check.mjs" --active
`;

try {
  const root = git("rev-parse", "--show-toplevel");
  // Git knows the repository-relative cwd even when Windows exposes path aliases.
  if (git("rev-parse", "--show-prefix")) throw new Error("请在 worktree 根目录执行");
  let configuredHooks = "";
  try {
    configuredHooks = git("config", "--get", "core.hooksPath");
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  if (configuredHooks) {
    throw new Error(`已有自定义 Git hooksPath (${configuredHooks})，不能擅自覆盖；请先人工整合守卫`);
  }
  git("cat-file", "-e", `${base}^{commit}`);
  const basePackage = JSON.parse(git("show", `${base}:package.json`));
  if (basePackage.name !== "werelay" ||
      !/^0\.\d+\.\d+(?:-|$)/.test(basePackage.version) ||
      !/github\.com\/imsinolam\/WeRelay(?:\.git)?$/.test(basePackage.repository?.url ?? "")) {
    throw new Error("指定提交不是 WeRelay 0.x 主线，不能作为活动基线");
  }
  const common = fs.realpathSync(path.resolve(root, git("rev-parse", "--git-common-dir")));
  const hooks = path.join(common, "hooks");
  const entry = path.join(hooks, "pre-commit");
  if (fs.existsSync(entry) && fs.readFileSync(entry, "utf8") !== hook) {
    throw new Error("已有 pre-commit hook，不能覆盖；请先人工整合守卫");
  }
  let previous = "";
  try {
    previous = git("show-ref", "--verify", "--hash", "refs/werelay/active-baseline");
  } catch {
    // No baseline has been recorded yet.
  }
  if (previous && previous !== base) {
    try {
      git("merge-base", "--is-ancestor", previous, base);
    } catch {
      throw new Error("新基线不是上一候选的后代；拒绝让守卫倒退或跨历史，请先审查发布链");
    }
  }
  fs.mkdirSync(hooks, { recursive: true });
  const guardSource = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-worktree-baseline.mjs");
  const guardTarget = path.join(hooks, "werelay-baseline-check.mjs");
  const temporary = `${guardTarget}.${process.pid}.tmp`;
  fs.copyFileSync(guardSource, temporary);
  fs.renameSync(temporary, guardTarget);
  fs.writeFileSync(entry, hook, { mode: 0o755 });
  fs.chmodSync(entry, 0o755);
  git("update-ref", "refs/werelay/active-baseline", base, previous || "0".repeat(40));
  console.log(`共享提交守卫已安装：active-baseline=${base}；旧历史 worktree 的提交将被拒绝`);
} catch (error) {
  console.error(`安装基线守卫失败：${error.message}`);
  process.exitCode = 1;
}
