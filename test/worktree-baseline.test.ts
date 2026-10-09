import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = path.resolve(import.meta.dir, "../scripts/check-worktree-baseline.mjs");
const installer = path.resolve(import.meta.dir, "../scripts/install-baseline-hook.mjs");

test("worktree preflight refuses old product identity and unrelated history", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-baseline-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  const run = (base: string) => spawnSync(process.execPath, [script, "--base", base], {
    cwd: directory, encoding: "utf8",
  });
  const writePackage = (name: string, version: string) => fs.writeFileSync(path.join(directory, "package.json"),
    JSON.stringify({ name, version, repository: { url: "git+https://github.com/imsinolam/WeRelay.git" } }));
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    writePackage("werelay", "0.3.14-preview.20260924.1");
    git("add", "package.json");
    git("commit", "-qm", "first");
    const base = git("rev-parse", "HEAD");
    expect(run(base).status).toBe(0);
    const subdirectory = path.join(directory, "nested");
    fs.mkdirSync(subdirectory);
    const fromChild = spawnSync(process.execPath, [script, "--base", base], {
      cwd: subdirectory, encoding: "utf8",
    });
    expect(fromChild.status).toBe(1);
    expect(fromChild.stderr).toContain("worktree 根目录");
    writePackage("deskrelay", "2.2.0");
    expect(run(base).status).toBe(1);
    writePackage("werelay", "0.3.14-preview.20260924.1");
    git("checkout", "--orphan", "unrelated");
    git("add", "package.json");
    git("commit", "-qm", "unrelated");
    const rejected = run(base);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("基线检查失败");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("shared commit hook rejects an obsolete worktree but accepts descendants of the deployed baseline", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-baseline-hook-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  const pkg = (name: string, version: string) => fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name, version, repository: { url: "git+https://github.com/imsinolam/WeRelay.git" } }),
  );
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    pkg("werelay", "0.3.15-preview.20260928.1");
    git("add", "package.json");
    git("commit", "-qm", "current preview");
    const base = git("rev-parse", "HEAD");
    const currentBranch = git("symbolic-ref", "--short", "HEAD");
    git("checkout", "--orphan", "obsolete");
    git("rm", "-rfq", ".");
    pkg("deskrelay", "2.1.1");
    git("add", "package.json");
    git("commit", "-qm", "historical product");
    git("checkout", currentBranch);
    const beforeInstall = spawnSync(process.execPath, [script, "--active"], { cwd: directory, encoding: "utf8" });
    expect(beforeInstall.status).toBe(1);
    expect(beforeInstall.stderr).toContain("当前基线");

    const installed = spawnSync(process.execPath, [installer, "--base", base], { cwd: directory, encoding: "utf8" });
    expect(installed.status).toBe(0);
    expect(git("show-ref", "--verify", "--hash", "refs/werelay/active-baseline")).toBe(base);
    expect(fs.readFileSync(path.join(directory, ".git/hooks/pre-commit"), "utf8")).toContain("--active");

    fs.writeFileSync(path.join(directory, "change.txt"), "newer branch\n");
    git("add", "change.txt");
    expect(spawnSync("git", ["commit", "-qm", "modern change"], { cwd: directory }).status).toBe(0);

    const oldWorktree = path.join(directory, "old-worktree");
    git("worktree", "add", "-q", oldWorktree, "obsolete");
    fs.writeFileSync(path.join(oldWorktree, "historical.txt"), "old branch edit\n");
    execFileSync("git", ["add", "historical.txt"], { cwd: oldWorktree });
    const rejected = spawnSync("git", ["commit", "-qm", "obsolete change"], {
      cwd: oldWorktree, encoding: "utf8",
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("基线检查失败");
    expect(git("show-ref", "--verify", "--hash", "refs/werelay/active-baseline")).toBe(base);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
