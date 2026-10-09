import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getBridgeProvider } from "../../src/bridge/bridge-providers.ts";
import { getLocalCompanionCommandName } from "../../src/bridge/bridge-adapter-common.ts";
import { createBridgeAdapter } from "../../src/bridge/bridge-adapters.ts";
import { PiOwnerAdapter } from "../../src/bridge/bridge-adapters.pi.ts";
import { parseDaemonSwitchCommand } from "../../src/daemon/werelay-daemon.ts";
import { listLightweightAdapterSessions } from "../../src/daemon/global-task-catalog.ts";

test("Pi CLI and messaging routes target the visible Pi owner, not a forked runtime", () => {
  expect(parseDaemonSwitchCommand("/PI")).toBe("pi");
  expect(parseDaemonSwitchCommand("/Pi Agent")).toBe("pi");
  expect(getLocalCompanionCommandName("pi")).toBe("werelay-pi");
  const adapter = createBridgeAdapter({ kind: "pi", command: "pi", cwd: process.cwd(), renderMode: "companion" });
  expect(adapter).toBeInstanceOf(PiOwnerAdapter);
  expect(getBridgeProvider("pi").capabilities).toMatchObject({ sessions: true, messages: true, queue: true, approvals: false, nativeCommands: false });
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  for (const bin of ["werelay-pi", "werelay-pi-start", "werelay-bridge-pi"]) {
    expect(fs.existsSync(packageJson.bin[bin])).toBe(true);
  }
});

test("global task list reads Pi native JSONL and retains project identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pi-global-"));
  const old = process.env.PI_CODING_AGENT_SESSION_DIR;
  try {
    process.env.PI_CODING_AGENT_SESSION_DIR = root;
    const projectDir = path.join(root, "--project--");
    fs.mkdirSync(projectDir);
    const id = "12345678-1234-1234-1234-123456789abc";
    fs.writeFileSync(path.join(projectDir, `2026-09-23_${id}.jsonl`), JSON.stringify({ type: "session", version: 3, id, cwd: "/tmp/pi-project", timestamp: "2026-09-23T00:00:00Z" }) + "\n");
    expect(await listLightweightAdapterSessions("pi", root, 10)).toMatchObject([{ sessionId: id, projectName: "pi-project", projectId: "/tmp/pi-project" }]);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = old;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
