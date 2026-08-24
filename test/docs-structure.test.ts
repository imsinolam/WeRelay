import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const requiredDocs = [
  "docs/README.md",
  "docs/使用指南/项目介绍.md",
  "docs/使用指南/Agent安装与配置.md",
  "docs/使用指南/GitHub源码安装与更新.md",
  "docs/使用指南/局域网移动网页快速开始.md",
  "docs/使用指南/公网Relay配置与验收.md",
  "docs/使用指南/运行配置.md",
  "docs/使用指南/问题排查.md",
  "docs/架构设计/架构与数据流.md",
  "docs/架构设计/局域网与公网访问.md",
  "docs/开发协作/开发与测试.md",
  "docs/开发协作/更名与版本边界.md",
  "docs/开发协作/多Agent协作规范.md",
  "docs/开发协作/任务职责与分工.md",
  "docs/发布/对外发布操作手册.md",
  "docs/发布/版本记录/版本索引.md",
  "docs/发布/版本记录/中文版本说明模板.md",
  "docs/发布/版本记录/历史预览/2.0.0.md",
  "docs/发布/版本记录/历史预览/2.1.4.md",
] as const;

const retiredFlatDocs = [
  "docs/about.md",
  "docs/agent-release-workflow.md",
  "docs/agent-setup.md",
  "docs/architecture.md",
  "docs/configuration.md",
  "docs/development.md",
  "docs/publishing.md",
  "docs/remote-access.md",
  "docs/troubleshooting.md",
] as const;
const retiredTopLevelPreviewNotes = [
  "docs/发布/版本记录/2.0.0.md",
  "docs/发布/版本记录/2.0.0-英文.md",
  "docs/发布/版本记录/2.0.1.md",
  "docs/发布/版本记录/2.0.1-英文.md",
  "docs/发布/版本记录/2.1.0.md",
  "docs/发布/版本记录/2.1.0-英文.md",
  "docs/发布/版本记录/2.1.1.md",
  "docs/发布/版本记录/2.1.1-英文.md",
  "docs/发布/版本记录/2.1.2.md",
  "docs/发布/版本记录/2.1.2-英文.md",
  "docs/发布/版本记录/2.1.3.md",
  "docs/发布/版本记录/2.1.3-英文.md",
  "docs/发布/版本记录/2.1.4.md",
  "docs/发布/版本记录/2.1.4-英文.md",
] as const;

function listMarkdownFiles(directory: string): string[] {
  const output: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...listMarkdownFiles(filePath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      output.push(filePath);
    }
  }
  return output;
}

describe("documentation structure", () => {
  test("uses the Chinese documentation hierarchy and exposes the Agent rules", () => {
    for (const filePath of requiredDocs) {
      expect(fs.existsSync(path.join(root, filePath))).toBe(true);
    }
    for (const filePath of [
      ...retiredFlatDocs,
      ...retiredTopLevelPreviewNotes,
    ]) {
      expect(fs.existsSync(path.join(root, filePath))).toBe(false);
    }

    const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    const docsIndex = fs.readFileSync(path.join(root, "docs/README.md"), "utf8");
    const renameBoundary = fs.readFileSync(
      path.join(root, "docs/开发协作/更名与版本边界.md"),
      "utf8",
    );
    expect(agents).toContain("docs/开发协作/更名与版本边界.md");
    expect(agents).toContain("DeskRelay is the retired product name");
    expect(docsIndex).toContain("开发协作/更名与版本边界.md");
    expect(renameBoundary).toContain("DeskRelay 已完成对外更名");
    expect(renameBoundary).toContain("正式版前的版本线 | `0.x.x`");
    expect(renameBoundary).toContain("禁止无差别全仓替换");
    expect(agents).toContain("docs/开发协作/多Agent协作规范.md");
    expect(docsIndex).toContain("开发协作/多Agent协作规范.md");
  });

  test("documents the protected candidate release baseline", () => {
    const publishing = fs.readFileSync(
      path.join(root, "docs/发布/对外发布操作手册.md"),
      "utf8",
    );
    const collaboration = fs.readFileSync(
      path.join(root, "docs/开发协作/多Agent协作规范.md"),
      "utf8",
    );
    const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");

    for (const check of [
      "Secret scan",
      "Quality (ubuntu-latest)",
      "Quality (macos-latest)",
      "Quality (windows-latest)",
    ]) {
      expect(publishing).toContain(check);
    }
    expect(publishing).toContain("`main` 推送会再次触发同一组 CI");
    expect(publishing).toContain("不允许 force push，不允许删除 `main`");
    expect(publishing).toContain("npm run privacy:check:history");
    expect(publishing).toContain("GitHub 是 WeRelay 唯一的公开发布和版本来源");
    expect(publishing).not.toContain("npm publish --dry-run");
    expect(collaboration).toContain("`main` 推送触发的最新一轮四项 CI");
    expect(agents).toContain("one-time candidate branch");
  });

  test("keeps local Markdown links valid after document moves", () => {
    const markdownFiles = [
      ...["README.md", "CONTRIBUTING.md", "SECURITY.md", "AGENTS.md"]
        .map((name) => path.join(root, name)),
      ...listMarkdownFiles(path.join(root, "docs")),
    ];
    const missing: string[] = [];
    const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;

    for (const markdownFile of markdownFiles) {
      const contents = fs.readFileSync(markdownFile, "utf8");
      for (const match of contents.matchAll(linkPattern)) {
        const rawTarget = (match[1] ?? "").trim().split(/\s+/, 1)[0]?.replace(/^<|>$/g, "") ?? "";
        if (
          !rawTarget || rawTarget.startsWith("#") ||
          /^https?:\/\//.test(rawTarget) || rawTarget.startsWith("mailto:")
        ) {
          continue;
        }
        const withoutFragment = rawTarget.split("#", 1)[0] ?? "";
        const target = path.resolve(
          path.dirname(markdownFile),
          decodeURIComponent(withoutFragment),
        );
        if (!fs.existsSync(target)) {
          missing.push(
            `${path.relative(root, markdownFile)} -> ${rawTarget}`,
          );
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
