import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSourceArchiveUrl, runWeRelayUpgrade, resolveGlobalInstallPath,
  formatUpgradeResultMessage, type UpgradePlan,
} from "../../src/daemon/clawbot-upgrade.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const version = "0.3.21-preview.10";
function setup(options: { wrongSource?: boolean; badPack?: boolean; failInstall?: boolean; wrongInstalled?: boolean; failHelp?: boolean; tarListing?: string; tarTypes?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-update-test-")); roots.push(root);
  const prefix = path.join(root, "prefix");
  const installPath = process.platform === "win32" ? path.join(prefix, "node_modules", "werelay")
    : path.join(prefix, "lib", "node_modules", "werelay");
  fs.mkdirSync(installPath, { recursive: true });
  const original = { name: "werelay", version: "0.3.20", bin: { werelay: "bin/werelay.mjs" } };
  fs.writeFileSync(path.join(installPath, "package.json"), JSON.stringify(original));
  fs.writeFileSync(path.join(installPath, "original.txt"), "old");
  fs.mkdirSync(path.join(installPath, "bin"));
  fs.writeFileSync(path.join(installPath, "bin", "werelay.mjs"), "// fixture");
  const binDir = process.platform === "win32" ? prefix : path.join(prefix, "bin"); fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, process.platform === "win32" ? "werelay.cmd" : "werelay");
  const writeShim = () => process.platform === "win32" ? fs.writeFileSync(bin, "old-shim")
    : fs.symlinkSync("../lib/node_modules/werelay/bin/werelay.mjs", bin);
  writeShim();
  const plan: UpgradePlan = { currentVersion: "0.3.20", targetVersion: version, tagName: `v${version}` };
  const calls: Array<{ file: string; args: string[]; options?: Record<string, unknown> }> = [];
  const execFileImpl = async (file: string, args: string[], execOptions?: Record<string, unknown>) => {
    calls.push({ file, args, options: execOptions });
    if (file.endsWith("tar") && args[0] === "-tzf") {
      return { stdout: options.tarListing ?? "WeRelay-release/\nWeRelay-release/package.json\nWeRelay-release/package-lock.json\n", stderr: "" };
    }
    if (file.endsWith("tar") && args[0] === "-tvzf") {
      return { stdout: options.tarTypes ?? "drwxr-xr-x root/root 0 release/\n-rw-r--r-- root/root 20 package.json\n-rw-r--r-- root/root 20 package-lock.json\n", stderr: "" };
    }
    if (file.endsWith("tar") && args[0] === "-xzf") {
      const target = args[args.indexOf("-C") + 1]!;
      fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: options.wrongSource ? "other" : "werelay", version,
        bin: { werelay: "bin/werelay.mjs" } }));
      fs.writeFileSync(path.join(target, "package-lock.json"), JSON.stringify({ name: "werelay", version, lockfileVersion: 3 }));
    }
    if (args[0] === "pack") {
      fs.writeFileSync(path.join(String(execOptions?.cwd), "werelay.tgz"), "packed");
      return { stdout: JSON.stringify([{ name: "werelay", version, filename: options.badPack ? "../escape.tgz" : "werelay.tgz" }]), stderr: "" };
    }
    if (args[0] === "install" && args.includes("--global")) {
      fs.writeFileSync(path.join(installPath, "package.json"), JSON.stringify({ name: "werelay", version: options.wrongInstalled ? "0.0.1" : version, bin: { werelay: "bin/werelay.mjs" } }));
      fs.unlinkSync(bin); // npm may replace the existing shim even on failure.
      if (options.failInstall) throw new Error("install failed");
      writeShim();
    }
    if (file === process.execPath && options.failHelp) throw new Error("missing dependency");
    return { stdout: "", stderr: "" };
  };
  return { plan, installPath, calls, execFileImpl, lockDir: path.join(root, "locks"),
    fetchImpl: (async () => new Response("archive")) as typeof fetch,
    readVersion: () => JSON.parse(fs.readFileSync(path.join(installPath, "package.json"), "utf8")).version,
    bin };
}

test("release archive keeps the exact published tag including previews and no-v tags", () => {
  expect(buildSourceArchiveUrl(`v${version}`)).toBe(`https://github.com/imsinolam/WeRelay/archive/refs/tags/v${version}.tar.gz`);
  expect(buildSourceArchiveUrl(version)).toContain(`/tags/${version}.tar.gz`);
  for (const tag of ["main", "../v0.3.21", "v0.3.21;echo x", "0.3.21-01"]) expect(buildSourceArchiveUrl(tag)).toBeNull();
});

test("confirmed preview uses npm ci + pack, and installs only that tarball in the running prefix", async () => {
  const f = setup(); const stages: string[] = [];
  const result = await runWeRelayUpgrade({ ...f, onStage: (stage) => { stages.push(stage); } });
  expect(result.status).toBe("upgraded"); expect(f.readVersion()).toBe(version);
  expect(f.calls.some((c) => c.args[0] === "ci")).toBe(true);
  const install = f.calls.find((c) => c.args.includes("--global"))!;
  expect(install.args.some((s) => s.endsWith(".tgz"))).toBe(true);
  expect(install.args).toContain("--prefix");
  expect(install.args).not.toContain("werelay@latest");
  expect(stages).toEqual(["download", "extract", "build", "install", "verify"]);
  expect(formatUpgradeResultMessage(result)).toContain("尚未重启");
});

test("invalid tags, mismatched versions and downgrades cannot download or run commands", async () => {
  for (const plan of [
    { currentVersion: version, targetVersion: "0.3.20", tagName: "v0.3.20" },
    { currentVersion: "0.3.20", targetVersion: version, tagName: "v9.0.0" },
    { currentVersion: "0.3.20", targetVersion: version, tagName: "main" },
  ]) {
    const f = setup(); let downloads = 0;
    const result = await runWeRelayUpgrade({ ...f, plan, fetchImpl: (async () => { downloads++; return new Response("x"); }) as typeof fetch });
    expect(result.status).toBe("failed"); expect(downloads).toBe(0); expect(f.calls).toHaveLength(0);
    expect(f.readVersion()).toBe("0.3.20");
  }
});

test("unrelated source package and unsafe pack paths are refused before replacing anything", async () => {
  for (const options of [{ wrongSource: true }, { badPack: true }]) {
    const f = setup(options); const result = await runWeRelayUpgrade(f);
    expect(result.status).toBe("failed"); expect(f.readVersion()).toBe("0.3.20");
    expect(f.calls.some((c) => c.args.includes("--global"))).toBe(false);
    if (options.wrongSource) expect(f.calls.some((c) => c.args[0] === "ci")).toBe(false);
  }
});

test("archive traversal and symlink entries are rejected before extraction", async () => {
  for (const options of [
    { tarListing: "root/../../evil\n" }, { tarListing: "/tmp/evil\n" },
    { tarListing: "root/good\nother/file\n" }, { tarTypes: "lrwxrwxrwx user 0 root/link -> /tmp\n" },
  ]) {
    const f = setup(options); expect((await runWeRelayUpgrade(f)).status).toBe("failed");
    expect(f.calls.some((c) => c.args[0] === "-xzf")).toBe(false);
  }
});

test("both installation failure and wrong installed version restore package and command shims", async () => {
  for (const options of [{ failInstall: true }, { wrongInstalled: true }, { failHelp: true }]) {
    const f = setup(options); const result = await runWeRelayUpgrade(f);
    expect(result).toMatchObject({ status: "failed", rolledBack: true });
    expect(f.readVersion()).toBe("0.3.20");
    expect(fs.readFileSync(path.join(f.installPath, "original.txt"), "utf8")).toBe("old");
    if (process.platform === "win32") expect(fs.readFileSync(f.bin, "utf8")).toBe("old-shim");
    else expect(fs.readlinkSync(f.bin)).toBe("../lib/node_modules/werelay/bin/werelay.mjs");
  }
});

test("network failure preserves the old package and releases the cross-workspace update lock", async () => {
  const f = setup();
  expect((await runWeRelayUpgrade({ ...f, fetchImpl: (async () => new Response("failed", { status: 503 })) as typeof fetch })).status).toBe("failed");
  expect(f.readVersion()).toBe("0.3.20");
  expect((await runWeRelayUpgrade(f)).status).toBe("upgraded");
});

test("only the running global package can be updated, not a source checkout or symlink", async () => {
  const f = setup();
  expect(await resolveGlobalInstallPath({ moduleDir: f.installPath })).toBe(f.installPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-source-test-")); roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "werelay", version }));
  expect(await resolveGlobalInstallPath({ moduleDir: root })).toBeNull();
});

test("a second workspace cannot replace the same global installation concurrently", async () => {
  const f = setup(); let unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const first = runWeRelayUpgrade({ ...f, fetchImpl: (async () => { await gate; return new Response("archive"); }) as typeof fetch });
  // The first job holds the lock before beginning its fetch.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await runWeRelayUpgrade(f);
  expect(second).toMatchObject({ status: "failed" }); expect(f.readVersion()).toBe("0.3.20");
  unblock(); expect((await first).status).toBe("upgraded");
});

test("aborting before replacement leaves the old installation intact", async () => {
  const f = setup(); const controller = new AbortController();
  const result = await runWeRelayUpgrade({ ...f, signal: controller.signal, onStage: (stage) => {
    if (stage === "install") controller.abort();
  } });
  expect(result.status).toBe("failed"); expect(f.readVersion()).toBe("0.3.20");
  expect(f.calls.some((c) => c.args.includes("--global"))).toBe(false);
});
