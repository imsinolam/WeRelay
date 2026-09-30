import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const website = `https://${["werelay", "sinolin", "com"].join(".")}/`;

describe("public README brand assets", () => {
  test("uses the approved wordmark and current user-facing message with a website entry", () => {
    expect(readme).toContain('src="docs/images/werelay-wordmark.png"');
    expect(readme).toContain('src="docs/images/werelay-relationship.png"');
    expect(readme).toContain("SAME AGENT. SAME THREAD. ANYWHERE.");
    expect(readme).toContain(website);
    expect(readme).not.toContain("One real session. Every screen.");
    expect(readme).not.toContain('src="docs/images/werelay-four-panel');
    for (const file of ["werelay-wordmark.png", "werelay-relationship.png"]) {
      const data = fs.readFileSync(path.join(root, "docs/images", file));
      expect(data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
    }
  });

  test("public diagram shows shipping adapters and keeps server and desktop boundaries explicit", () => {
    const svg = fs.readFileSync(path.join(root, "docs/images/werelay-relationship-simple.svg"), "utf8");
    for (const label of ["Codex", "WorkBuddy", "Claude Code", "TClaude", "Grok CLI", "CodeBuddy", "OpenCode", "reasonix", "DeepSeek Harness"]) {
      expect(svg).toContain(label);
    }
    expect(svg).not.toContain("Pi Agent");
    expect(svg).toContain("无需云服务器");
    expect(svg).toContain("外网访问");
    expect(svg).toContain("电脑保持开机");
    expect(svg).toContain('marker-start="url(#arrow)"');
    expect(svg).toContain('marker-end="url(#arrow)"');
  });

  test("relative documentation and image links resolve and package metadata points to the official website", () => {
    const links = [
      ...[...readme.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]),
      ...[...readme.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]),
    ];
    for (const link of links) {
      if (link.startsWith("#") || /^[a-z]+:/i.test(link)) continue;
      const file = decodeURIComponent(link.split("#")[0]);
      expect(fs.existsSync(path.resolve(root, file))).toBe(true);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.homepage).toBe(website);
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    expect(pkg.version).toBe(lock.version);
    expect(pkg.private).toBe(true);
    expect(pkg.files).toContain("docs/images/werelay-wordmark.png");
    expect(pkg.files).toContain("docs/images/werelay-relationship.png");
  });
});
