import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createSafetyFixture(contents: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-public-safety-"));
  temporaryDirectories.push(directory);
  fs.mkdirSync(path.join(directory, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.resolve(import.meta.dir, "..", "..", "scripts/check-public-safety.mjs"),
    path.join(directory, "scripts/check-public-safety.mjs"),
  );
  fs.writeFileSync(path.join(directory, "README.md"), contents);
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  return directory;
}

describe("public safety script", () => {
  test("rejects personal production domains", () => {
    const privateHost = ["relay", "sinolin", "com"].join(".");
    const directory = createSafetyFixture(`Service: https://${privateHost}`);
    const result = spawnSync(
      "node",
      ["scripts/check-public-safety.mjs"],
      { cwd: directory, encoding: "utf8" },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "personal production domain must use a reserved example domain",
    );
  });

  test("allows reserved example domains", () => {
    const directory = createSafetyFixture("Service: https://relay.example.com");
    const result = spawnSync(
      "node",
      ["scripts/check-public-safety.mjs"],
      { cwd: directory, encoding: "utf8" },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Public safety check passed");
  });
});
