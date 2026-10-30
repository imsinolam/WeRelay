import { expect, test } from "bun:test";
import crypto from "node:crypto";
import { signMobileAppBundle } from "../../src/daemon/mobile-app-bundle.ts";
const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const options = {
  version: "012345abcdef", sequence: 1, minShellVersion: 1,
  privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const files = { "index.html": "首页", "app.js": "void 0", "native-platform.js": "void 0" };

test("signed payload authenticates exact UTF-8 bytes and per-file hashes", () => {
  const bundle = signMobileAppBundle(files, options);
  const bytes = Buffer.from(bundle.payload, "base64");
  const signature = Buffer.from(bundle.signature, "base64");
  expect(crypto.verify("sha256", bytes, keys.publicKey, signature)).toBe(true);
  expect(crypto.verify("sha256", Buffer.concat([bytes, Buffer.from(" ")]), keys.publicKey, signature)).toBe(false);
  const payload = JSON.parse(bytes.toString());
  expect(Buffer.from(payload.files["index.html"].content, "base64").toString()).toBe("首页");
  expect(payload.files["index.html"].sha256).toBe(crypto.createHash("sha256").update("首页").digest("hex"));
});

test("bundle rejects traversal, missing entrypoints and invalid versions", () => {
  expect(() => signMobileAppBundle({ ...files, "../evil.js": "bad" }, options)).toThrow("path");
  expect(() => signMobileAppBundle({ "index.html": "" }, options)).toThrow("Incomplete");
  expect(() => signMobileAppBundle(files, { ...options, sequence: 0 })).toThrow("metadata");
  expect(() => signMobileAppBundle(files, { ...options, version: "../bad" })).toThrow("metadata");
});
