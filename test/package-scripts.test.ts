import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const packageJson = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dir, "..", "package.json"), "utf8"),
) as { scripts?: Record<string, string> };

describe("package quality scripts", () => {
  test("scans complete Git history for committed secrets in CI", () => {
    const workflow = fs.readFileSync(
      path.resolve(import.meta.dir, "..", ".github/workflows/ci.yml"),
      "utf8",
    );
    expect(workflow).toContain("name: Secret scan");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("gitleaks_8.30.1_linux_x64.tar.gz");
    expect(workflow).toContain(
      "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    );
    expect(workflow).toContain("gitleaks\" git . --redact=100 --no-banner");
  });

  test("rejects personal production domains from public snapshots", () => {
    const safetyScript = fs.readFileSync(
      path.resolve(import.meta.dir, "..", "scripts/check-public-safety.mjs"),
      "utf8",
    );
    expect(safetyScript).toContain('["sinolin", "com"].join(".")');
    expect(safetyScript).toContain(
      "personal production domain must use a reserved example domain",
    );
  });

  test("gates protected main pushes through a checked candidate branch", () => {
    const workflow = fs.readFileSync(
      path.resolve(import.meta.dir, "..", ".github/workflows/ci.yml"),
      "utf8",
    );
    const helper = fs.readFileSync(
      path.resolve(
        import.meta.dir,
        "..",
        "deploy/github-publish-server/werelay-github-publish-remote",
      ),
      "utf8",
    );
    expect(workflow).toContain('"werelay-release-candidate/**"');
    expect(helper).toContain("werelay-release-candidate/");
    expect(helper).toContain("wait_for_required_checks");
    expect(helper).toContain("candidate commit is not a fast-forward of GitHub main");
    expect(helper).toContain("GitHub main changed while candidate checks were running");
    expect(helper).toContain("Secret scan|Quality (ubuntu-latest)|Quality (macos-latest)|Quality (windows-latest)");
  });

  test("ships the server-only GitHub publishing entrypoint", () => {
    expect(packageJson.files).toContain("scripts/publish-github-via-server.mjs");
    expect(packageJson.scripts["github:publish:server"]).toBe(
      "node scripts/publish-github-via-server.mjs",
    );
  });

  test("prepack typechecks source before building the npm package", () => {
    expect(packageJson.scripts?.prepack).toBe(
      "npm run typecheck:src && npm run build",
    );
  });

  test("ships the DeepSeek Harness bridge entrypoints", () => {
    expect(packageJson.scripts?.["bridge:deepseek"]).toBe(
      "node --no-warnings --experimental-strip-types src/bridge/werelay-bridge.ts --adapter deepseek",
    );
    const bin = (packageJson as { bin?: Record<string, string> }).bin;
    expect(bin?.["werelay-bridge-deepseek"]).toBe(
      "bin/werelay-bridge-deepseek.mjs",
    );
  });

  test("gives the hardened relay service a writable private task-link state directory", () => {
    const service = fs.readFileSync(
      path.resolve(import.meta.dir, "..", "deploy/systemd/werelay-relay.service.example"),
      "utf8",
    );
    const environment = fs.readFileSync(
      path.resolve(import.meta.dir, "..", "deploy/systemd/werelay-relay.env.example"),
      "utf8",
    );
    expect(service).toContain("StateDirectory=werelay");
    expect(service).toContain("StateDirectoryMode=0700");
    expect(environment).toContain(
      "WERELAY_RELAY_TASK_LINK_STATE_FILE=/var/lib/werelay/relay-task-links.json",
    );
  });
});
