#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createMobileAppAssets } from "../src/daemon/mobile-app-assets.ts";
import { signMobileAppBundle } from "../src/daemon/mobile-app-bundle.ts";

const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
if (!args.includes("--out") || !args.includes("--platform")) {
  throw new Error("Usage: node scripts/export-mobile-app.mjs --out <directory> --platform <native-platform.js> [--sign-key <PEM> --sequence <integer>]");
}
const output = path.resolve(value("--out"));
const bundle = createMobileAppAssets();
bundle.files["native-platform.js"] = fs.readFileSync(value("--platform"), "utf8");
bundle.files["app-build.json"] = JSON.stringify({ schema: 1, version: bundle.version, shellVersion: 1 });
for (const [name, content] of Object.entries(bundle.files)) {
  const target = path.join(output, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
if (args.includes("--sign-key")) {
  const envelope = signMobileAppBundle(bundle.files, {
    version: bundle.version, sequence: Number(value("--sequence")), minShellVersion: 1,
    privateKey: fs.readFileSync(value("--sign-key"), "utf8"),
  });
  fs.writeFileSync(path.join(output, "app-bundle.json"), JSON.stringify(envelope));
}
console.log(JSON.stringify({ version: bundle.version, files: Object.keys(bundle.files), output }));
