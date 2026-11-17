import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMessageJournal } from "../../src/message-journal/journal.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-integration-")); dirs.push(dir);
  const root = path.join(dir, "sessions"); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "session.jsonl"), [
    { type: "session", id: "s", cwd: "/example/project" },
    { type: "message", id: "u", timestamp: Date.now(), message: { role: "user", content: "检查搜索功能" } },
  ].map(row => JSON.stringify(row)).join("\n"));
  return { dir, root, permissionFile: path.join(dir, "permissions.json") };
}
test("refuses to scan before consent, persists selected sources, and revokes immediately", async () => {
  const { permissionFile, root } = setup();
  const journal = createMessageJournal({ permissionFile, roots: [{ agent: "pi", root }] });
  expect((await journal.read()).messages).toEqual([]);
  expect(fs.existsSync(permissionFile)).toBe(false);
  await journal.setPermissions(["pi"]);
  const data = await journal.read();
  expect(data.messages).toHaveLength(1);
  expect(data.messages[0]?.text).toBe("检查搜索功能");
  expect(data.permissions.agents).toEqual(["pi"]);
  // Windows reports synthetic mode bits; consent and revocation remain tested above and below.
  if (process.platform !== "win32") expect(fs.statSync(permissionFile).mode & 0o777).toBe(0o600);
  expect((await createMessageJournal({ permissionFile, roots: [{ agent: "pi", root }] }).read()).messages).toHaveLength(1);
  await journal.setPermissions([]);
  expect((await journal.read()).messages).toEqual([]);
  expect(() => journal.setPermissions(["made-up"])).toThrow();
});
test("revocation during an in-flight scan discards the result", async () => {
  const { permissionFile } = setup();
  let finish!: (value: any) => void;
  const journal = createMessageJournal({ permissionFile, scan: () => new Promise(resolve => { finish = resolve; }) });
  await journal.setPermissions(["pi"]);
  const pending = journal.read();
  await new Promise(resolve => setTimeout(resolve, 0));
  await journal.setPermissions([]);
  finish({ messages: [{ agent: "pi", id: "private", text: "old" }], sources: [] });
  expect((await pending).messages).toEqual([]);
});

test("unchanged polling omits large message bodies and revisions change after revocation or restart", async () => {
  const { permissionFile } = setup();
  let scans = 0;
  const scan = async () => {
    scans++;
    return { sources: [], messages: Array.from({length: 2000}, (_, i) => ({agent:"pi", id:String(i), text:"回归数据".repeat(250)})) };
  };
  const journal = createMessageJournal({ permissionFile, scan });
  journal.setPermissions(["pi"]);
  const first = await journal.read();
  expect(first.messages).toHaveLength(2000);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeGreaterThan(2_000_000);
  journal.setPermissions(["pi"]);
  const next = await journal.read(false, first.revision);
  expect(next.unchanged).toBe(true);
  expect(next.messages).toEqual([]);
  expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(2048);
  expect(scans).toBe(1);
  journal.setPermissions([]);
  const revoked = await journal.read(false, first.revision);
  expect(revoked.unchanged).toBe(false);
  expect(revoked.permissions.agents).toEqual([]);
  expect(revoked.messages).toEqual([]);
  expect((await createMessageJournal({permissionFile, scan}).read()).revision).not.toBe(revoked.revision);
});
