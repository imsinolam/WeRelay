import { describe, expect, test } from "bun:test";

import {
  containsPersonalProductionDomain,
} from "../../scripts/public-safety-rules.mjs";

describe("public safety rules", () => {
  test("rejects personal production domains", () => {
    const privateHost = ["relay", "sinolin", "com"].join(".");

    expect(containsPersonalProductionDomain(`Service: https://${privateHost}`)).toBe(true);
  });

  test("allows reserved example domains", () => {
    expect(
      containsPersonalProductionDomain("Service: https://relay.example.com"),
    ).toBe(false);
  });

  test("allows only the approved public website root in explicitly approved marketing files", () => {
    const website = `https://${["werelay", "sinolin", "com"].join(".")}/`;
    expect(containsPersonalProductionDomain(website)).toBe(true);
    expect(containsPersonalProductionDomain(`[官网](${website})`, { allowMarketingWebsite: true })).toBe(false);
    for (const suffix of ["?task=private-task", "app", "#private", "api/health"]) {
      expect(containsPersonalProductionDomain(website + suffix, { allowMarketingWebsite: true })).toBe(true);
    }
    const privateHost = ["relay", "sinolin", "com"].join(".");
    expect(containsPersonalProductionDomain(`${website} https://${privateHost}`, { allowMarketingWebsite: true })).toBe(true);
    expect(containsPersonalProductionDomain(website.replace("https:", "http:"), { allowMarketingWebsite: true })).toBe(true);
  });

  test("allows the exact approved public demo video but not other media or private links", () => {
    const website = `https://${["werelay", "sinolin", "com"].join(".")}/`;
    const video = `${website}__website/assets/media/WeRelay-60s-Film.mp4`;
    expect(containsPersonalProductionDomain(video)).toBe(true);
    expect(containsPersonalProductionDomain(`[演示](${video})`, { allowMarketingWebsite: true })).toBe(false);
    for (const suffix of ["?task=private-task", "#private", "/other", ".backup"]) {
      expect(containsPersonalProductionDomain(video + suffix, { allowMarketingWebsite: true })).toBe(true);
    }
    for (const url of [
      `${website}__website/assets/media/private.mp4`,
      `${website}__website/assets/screenshots/private.png`,
      `${website}api/health`,
      video.replace("https:", "http:"),
    ]) {
      expect(containsPersonalProductionDomain(url, { allowMarketingWebsite: true })).toBe(true);
    }
  });
});
