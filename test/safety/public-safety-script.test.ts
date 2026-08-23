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
});
