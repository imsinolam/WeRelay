import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "bun:test";

const exec = promisify(execFile);
const sourceUrl = new URL("../../src/bridge/bridge-adapters.codex.ts", import.meta.url).href;

test("Codex catalog worker keeps pending work alive but lets a standalone reader exit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-catalog-lifecycle-"));
  try {
    const script = path.join(dir, "probe.mts");
    fs.writeFileSync(script, `import {readCodexStateDbSessionCatalog as read} from ${JSON.stringify(sourceUrl)};
      const options={databasePath:${JSON.stringify(path.join(dir,"missing.sqlite"))},catalogDatabasePath:${JSON.stringify(path.join(dir,"missing-catalog.sqlite"))}};
      const values=await Promise.all([read(options),read(options)]);
      console.log(JSON.stringify(values));`);
    const { stdout } = await exec("node", ["--experimental-transform-types", script], { timeout: 4_000 });
    expect(stdout.trim()).toBe("[null,null]");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 6_000);

test("Codex catalog worker does not inherit eval-only input-type flags", async () => {
  const script = `import {readCodexStateDbSessionCatalog as read} from ${JSON.stringify(sourceUrl)};
    console.log(await read({databasePath:"/nonexistent/catalog.sqlite",catalogDatabasePath:"/nonexistent/catalog-local.sqlite"}));`;
  const { stdout } = await exec("node", ["--experimental-transform-types", "--input-type=module", "-e", script], { timeout: 4_000 });
  expect(stdout.trim()).toBe("null");
}, 6_000);
