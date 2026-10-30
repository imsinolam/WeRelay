import crypto from "node:crypto";
import fs from "node:fs";
import type { ServerResponse } from "node:http";

export const MOBILE_APP_BUNDLE_MAX_BYTES = 16 * 1024 * 1024;
export type MobileAppBundlePayload = {
  schema: 1;
  version: string;
  sequence: number;
  minShellVersion: number;
  files: Record<string, { content: string; sha256: string }>;
};
export type SignedMobileAppBundle = { algorithm: "SHA256withECDSA"; payload: string; signature: string };

export function signMobileAppBundle(
  files: Record<string, string>,
  options: { version: string; sequence: number; minShellVersion: number; privateKey: string },
): SignedMobileAppBundle {
  if (!/^[a-f0-9]{12}$/.test(options.version) || !Number.isSafeInteger(options.sequence) || options.sequence < 1 ||
      !Number.isSafeInteger(options.minShellVersion) || options.minShellVersion < 1) throw new Error("Invalid bundle metadata");
  const payload: MobileAppBundlePayload = {
    schema: 1, version: options.version, sequence: options.sequence,
    minShellVersion: options.minShellVersion, files: {},
  };
  for (const name of Object.keys(files).sort()) {
    if (!/^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:html|js|css|json)$/.test(name)) throw new Error("Invalid bundle path");
    const bytes = Buffer.from(files[name]!, "utf8");
    payload.files[name] = { content: bytes.toString("base64"), sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  }
  if (!payload.files["index.html"] || !payload.files["app.js"] || !payload.files["native-platform.js"]) throw new Error("Incomplete bundle");
  const bytes = Buffer.from(JSON.stringify(payload));
  const key = crypto.createPrivateKey(options.privateKey);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("Expected P-256 signing key");
  const signed: SignedMobileAppBundle = {
    algorithm: "SHA256withECDSA", payload: bytes.toString("base64"),
    signature: crypto.sign("sha256", bytes, key).toString("base64"),
  };
  if (Buffer.byteLength(JSON.stringify(signed)) > MOBILE_APP_BUNDLE_MAX_BYTES) throw new Error("Bundle too large");
  return signed;
}

/** Optional, release-provisioned signed artifact. Never signs with a server-held key. */
export function serveMobileAppBundle(response: ServerResponse): void {
  const file = process.env.WERELAY_MOBILE_APP_BUNDLE;
  if (!file) {
    response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: "尚未配置 App 任务台更新包。" }));
    return;
  }
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MOBILE_APP_BUNDLE_MAX_BYTES) throw new Error("Invalid artifact");
    const body = fs.readFileSync(file);
    const data = JSON.parse(body.toString("utf8")) as Partial<SignedMobileAppBundle>;
    if (data.algorithm !== "SHA256withECDSA" || typeof data.payload !== "string" || typeof data.signature !== "string") throw new Error("Invalid artifact");
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache", "content-length": body.length });
    response.end(body);
  } catch {
    response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: "App 更新包暂时不可用。" }));
  }
}
