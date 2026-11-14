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
