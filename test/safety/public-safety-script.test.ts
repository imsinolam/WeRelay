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
});
