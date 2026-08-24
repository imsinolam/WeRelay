import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

export type ImmutableTextAsset = {
  body: Buffer;
  brotli: Buffer;
  gzip: Buffer;
  etag: string;
};

export function createImmutableTextAsset(body: string): ImmutableTextAsset {
  const buffer = Buffer.from(body, "utf8");
  const hash = crypto.createHash("sha256").update(buffer).digest("base64url").slice(0, 22);
  return {
    body: buffer,
    brotli: brotliCompressSync(buffer, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 5,
      },
    }),
    gzip: gzipSync(buffer, { level: 6 }),
    etag: `W/"${hash}"`,
  };
}

function requestAcceptsEncoding(request: IncomingMessage, encoding: string): boolean {
  const header = request.headers["accept-encoding"];
  if (typeof header !== "string") return false;
  return header.split(",").some((entry) => {
    const [name, ...params] = entry.trim().toLowerCase().split(";");
    if (name !== encoding && name !== "*") return false;
    return !params.some((param) => /^q=0(?:\.0*)?$/.test(param.trim()));
  });
}

function requestHasMatchingEtag(request: IncomingMessage, etag: string): boolean {
  const header = request.headers["if-none-match"];
  if (typeof header !== "string") return false;
  return header.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized === etag;
  });
}

export function sendImmutableTextAsset(
  request: IncomingMessage,
  response: ServerResponse,
  contentType: string,
  asset: ImmutableTextAsset,
  headers: Record<string, string> = {},
): void {
  const commonHeaders = {
    "cache-control": "public, max-age=31536000, immutable",
    etag: asset.etag,
    vary: "Accept-Encoding",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  };
  if (requestHasMatchingEtag(request, asset.etag)) {
    response.writeHead(304, commonHeaders);
    response.end();
    return;
  }

  const encoding = requestAcceptsEncoding(request, "br")
    ? "br"
    : requestAcceptsEncoding(request, "gzip")
      ? "gzip"
      : null;
  const body = encoding === "br"
    ? asset.brotli
    : encoding === "gzip"
      ? asset.gzip
      : asset.body;
  response.writeHead(200, {
    ...commonHeaders,
    "content-type": contentType,
    "content-length": String(body.length),
    ...(encoding ? { "content-encoding": encoding } : {}),
  });
  response.end(body);
}
