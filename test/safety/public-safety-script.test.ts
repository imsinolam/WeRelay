import { describe, expect, test } from "bun:test";

import {
  containsPersonalProductionDomain,
  isPrivateWebsitePath,
} from "../../scripts/public-safety-rules.mjs";

describe("public safety rules", () => {
  test("rejects private website paths even if force-added to Git", () => {
    for (const file of [
      "website/index.html",
      "docs/官网素材/官网演示数据.json",
      "scripts/generate-brand-logo.mjs",
      "WeRelay-website-private/site/index.html",
      "werelay-website-private\\site\\index.html",
    ]) {
      expect(isPrivateWebsitePath(file)).toBe(true);
    }
    for (const file of [
      "src/daemon/codex-mobile-web.ts",
      "src/daemon/codex-mobile-brand.ts",
      "docs/开发协作/公开仓库与官网边界.md",
      "docs/images/werelay-wordmark.png",
      "deploy/nginx/werelay.conf.example",
    ]) {
      expect(isPrivateWebsitePath(file)).toBe(false);
    }
  });

  test("rejects personal production domains", () => {
    const privateHost = ["relay", "sinolin", "com"].join(".");

    expect(containsPersonalProductionDomain(`Service: https://${privateHost}`)).toBe(true);
  });

  test("allows reserved example domains", () => {
    expect(
      containsPersonalProductionDomain("Service: https://relay.example.com"),
    ).toBe(false);
  });
});
