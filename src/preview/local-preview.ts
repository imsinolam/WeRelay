import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_TOTAL_BYTES = 18 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 6 * 1024 * 1024;
const DEFAULT_STORE_TTL_MS = 15 * 60_000;
const DEFAULT_STORE_MAX_DEPLOYMENTS = 12;
const DEFAULT_STORE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const PREVIEW_CONTENT_SECURITY_POLICY = [
  "sandbox allow-scripts allow-downloads allow-popups allow-modals",
  "default-src 'self' data: blob: https: http:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https: http:",
  "style-src 'self' 'unsafe-inline' data: blob: https: http:",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob: https: http:",
  "connect-src https: http: ws: wss:",
  "frame-src 'self' data: blob: https: http:",
  "object-src 'self' data: blob:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

export type LocalPreviewFile = {
  path: string;
  contentType: string;
  bodyBase64: string;
};

export type LocalPreviewPackage = {
  version: 1;
  deploymentId: string;
  sourceLabel: string;
  entryPath: string;
  createdAtMs: number;
  totalBytes: number;
  files: LocalPreviewFile[];
};

export type LocalPreviewProgress = {
  progress: number;
  message: string;
};

export function isLocalPreviewPackage(value: unknown): value is LocalPreviewPackage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.deploymentId !== "string" ||
    !/^[A-Za-z0-9_-]{8,160}$/.test(record.deploymentId) ||
    typeof record.sourceLabel !== "string" ||
    record.sourceLabel.length > 512 ||
    typeof record.entryPath !== "string" ||
    typeof record.createdAtMs !== "number" ||
    typeof record.totalBytes !== "number" ||
    !Number.isSafeInteger(record.totalBytes) ||
    record.totalBytes < 0 ||
    !Array.isArray(record.files) ||
    record.files.length === 0 ||
    record.files.length > DEFAULT_MAX_FILES
  ) return false;
  let totalBytes = 0;
  let entryFound = false;
  const seenPaths = new Set<string>();
  for (const candidate of record.files) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const file = candidate as Record<string, unknown>;
    if (
      typeof file.path !== "string" ||
      typeof file.contentType !== "string" ||
      typeof file.bodyBase64 !== "string" ||
      file.contentType.length > 256 ||
      file.bodyBase64.length > Math.ceil(DEFAULT_MAX_FILE_BYTES * 4 / 3) + 4
    ) return false;
    const normalizedPath = normalizeStoredPath(file.path);
    if (!normalizedPath || seenPaths.has(normalizedPath)) return false;
    seenPaths.add(normalizedPath);
    if (normalizedPath === normalizeStoredPath(record.entryPath)) entryFound = true;
    const body = Buffer.from(file.bodyBase64, "base64");
    if (body.toString("base64") !== file.bodyBase64 || body.length > DEFAULT_MAX_FILE_BYTES) {
      return false;
    }
    totalBytes += body.length;
    if (totalBytes > DEFAULT_MAX_TOTAL_BYTES) return false;
  }
  return entryFound && totalBytes === record.totalBytes;
}

export type CreateLocalPreviewPackageOptions = {
  workspaceRoot: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
  onProgress?: (progress: LocalPreviewProgress) => void;
};

export class LocalPreviewError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

type HttpSource = {
  kind: "http";
  url: URL;
  rootOrigin: string;
};

type FileSource = {
  kind: "file";
  filePath: string;
  workspaceRoot: string;
};

type PreviewSource = HttpSource | FileSource;

type CapturedResource = {
  source: PreviewSource;
  outputPath: string;
  contentType: string;
  body: Buffer;
  processing?: Promise<void>;
};

type CaptureContext = {
  fetchImpl: typeof fetch;
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  rawBytes: number;
  resources: Map<string, CapturedResource>;
  onProgress: (progress: LocalPreviewProgress) => void;
};

const CONTENT_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" ||
    normalized === "::1";
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function resolveWorkspaceRoot(value: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(value);
  } catch {
    throw new LocalPreviewError(500, "当前工作区不存在，无法准备手机预览。");
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new LocalPreviewError(500, "当前工作区不是有效目录。");
  }
  return resolved;
}

function resolveWorkspaceFile(value: string, workspaceRoot: string): string {
  const absolute = path.resolve(value);
  let resolved: string;
  try {
    resolved = fs.realpathSync(absolute);
  } catch {
    throw new LocalPreviewError(404, "本地文件不存在或已经移动。");
  }
  if (!isWithinRoot(workspaceRoot, resolved)) {
    throw new LocalPreviewError(403, "为保护电脑文件，只能预览当前工作区内的文件。");
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new LocalPreviewError(400, "请选择一个具体文件，暂不支持直接预览目录。");
  }
  return resolved;
}

function parseRootSource(target: string, workspaceRoot: string): PreviewSource {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new LocalPreviewError(400, "缺少要预览的本地链接或文件。");
  }

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new LocalPreviewError(400, "本地页面地址无效。");
    }
    if (url.username || url.password || !isLoopbackHostname(url.hostname)) {
      throw new LocalPreviewError(403, "只支持预览这台电脑上的回环地址页面。");
    }
    url.hash = "";
    return { kind: "http", url, rootOrigin: url.origin };
  }

  if (/^file:/i.test(trimmed)) {
    let filePath: string;
    try {
      filePath = fileURLToPath(trimmed);
    } catch {
      throw new LocalPreviewError(400, "本地文件地址无效。");
    }
    return {
      kind: "file",
      filePath: resolveWorkspaceFile(filePath, workspaceRoot),
      workspaceRoot,
    };
  }

  if (path.isAbsolute(trimmed)) {
    return {
      kind: "file",
      filePath: resolveWorkspaceFile(trimmed, workspaceRoot),
      workspaceRoot,
    };
  }

  throw new LocalPreviewError(
    400,
    "只支持 127.0.0.1、localhost、file:// 或当前工作区内的绝对文件路径。",
  );
}

function sourceKey(source: PreviewSource): string {
  return source.kind === "http"
    ? source.url.toString()
    : pathToFileURL(source.filePath).toString();
}

function sourceLabel(source: PreviewSource): string {
  if (source.kind === "http") {
    return `${source.url.hostname}${source.url.port ? `:${source.url.port}` : ""}${source.url.pathname}`;
  }
  return path.basename(source.filePath);
}

function sourcePathname(source: PreviewSource): string {
  return source.kind === "http" ? source.url.pathname : source.filePath;
}

function contentTypeFromPath(value: string): string {
  return CONTENT_TYPES[path.extname(value).toLowerCase()] ?? "application/octet-stream";
}

function normalizedContentType(value: string | null, source: PreviewSource): string {
  const trimmed = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!trimmed || trimmed === "application/octet-stream") {
    return contentTypeFromPath(sourcePathname(source));
  }
  if (
    trimmed.startsWith("text/") ||
    trimmed === "application/javascript" ||
    trimmed === "application/json" ||
    trimmed === "application/xml" ||
    trimmed === "image/svg+xml"
  ) {
    return `${trimmed}; charset=utf-8`;
  }
  return trimmed;
}

function extensionForContentType(contentType: string): string {
  const mime = contentType.split(";", 1)[0]?.trim().toLowerCase();
  const entry = Object.entries(CONTENT_TYPES).find(([, value]) =>
    value.split(";", 1)[0] === mime
  );
  return entry?.[0] ?? "";
}

function safeOutputName(source: PreviewSource, contentType: string): string {
  const sourceName = path.basename(sourcePathname(source)) || "asset";
  const extension = path.extname(sourceName) || extensionForContentType(contentType);
  const stem = path.basename(sourceName, path.extname(sourceName))
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "asset";
  const digest = crypto.createHash("sha256").update(sourceKey(source)).digest("hex").slice(0, 12);
  return `assets/${digest}-${stem}${extension}`;
}

function relativeAssetPath(from: string, to: string): string {
  const relative = path.posix.relative(path.posix.dirname(from), to);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function isHtml(contentType: string): boolean {
  return contentType.startsWith("text/html");
}

function isCss(contentType: string): boolean {
  return contentType.startsWith("text/css");
}

function isJavaScript(contentType: string): boolean {
  return contentType.includes("javascript") || contentType.includes("ecmascript");
}

async function readResponseBodyLimited(response: Response, limit: number): Promise<Buffer> {
  const advertised = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(advertised) && advertised > limit) {
    throw new LocalPreviewError(413, "本地页面中的单个文件过大，无法部署到手机预览。");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const chunk = Buffer.from(result.value);
    size += chunk.length;
    if (size > limit) {
      await reader.cancel();
      throw new LocalPreviewError(413, "本地页面中的单个文件过大，无法部署到手机预览。");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function fetchHttpSource(
  source: HttpSource,
  context: CaptureContext,
): Promise<{ body: Buffer; contentType: string; effectiveSource: HttpSource }> {
  let url = new URL(source.url);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    let response: Response;
    try {
      response = await context.fetchImpl(url, { redirect: "manual" });
    } catch {
      throw new LocalPreviewError(502, "电脑上的本地页面暂时无法读取，请确认它仍在运行。");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === MAX_REDIRECTS) {
        throw new LocalPreviewError(502, "本地页面重定向次数过多。");
      }
      const next = new URL(location, url);
      if (
        !isLoopbackHostname(next.hostname) ||
        next.origin !== source.rootOrigin ||
        next.username || next.password
      ) {
        throw new LocalPreviewError(403, "本地页面试图跳转到未授权地址，已停止预览。");
      }
      next.hash = "";
      url = next;
      continue;
    }
    if (!response.ok) {
      throw new LocalPreviewError(
        response.status === 404 ? 404 : 502,
        `本地页面返回了 ${response.status}，无法准备预览。`,
      );
    }
    const body = await readResponseBodyLimited(response, context.maxFileBytes);
    return {
      body,
      contentType: normalizedContentType(response.headers.get("content-type"), {
        ...source,
        url,
      }),
      effectiveSource: { ...source, url },
    };
  }
  throw new LocalPreviewError(502, "本地页面无法读取。");
}

function readFileSource(
  source: FileSource,
  context: CaptureContext,
): { body: Buffer; contentType: string; effectiveSource: FileSource } {
  const filePath = resolveWorkspaceFile(source.filePath, source.workspaceRoot);
  const stat = fs.statSync(filePath);
  if (stat.size > context.maxFileBytes) {
    throw new LocalPreviewError(413, "本地文件过大，无法部署到手机预览。");
  }
  return {
    body: fs.readFileSync(filePath),
    contentType: contentTypeFromPath(filePath),
    effectiveSource: { ...source, filePath },
  };
}

async function replaceAsync(
  value: string,
  expression: RegExp,
  replacer: (...args: string[]) => Promise<string>,
): Promise<string> {
  const matches = [...value.matchAll(expression)];
  if (matches.length === 0) return value;
  const replacements = await Promise.all(matches.map((match) =>
    replacer(...match.map((part) => part ?? ""))
  ));
  let output = "";
  let cursor = 0;
  matches.forEach((match, index) => {
    const matchIndex = match.index ?? 0;
    output += value.slice(cursor, matchIndex) + replacements[index];
    cursor = matchIndex + match[0].length;
  });
  return output + value.slice(cursor);
}

function resolveReference(reference: string, base: PreviewSource): PreviewSource | null {
  const trimmed = reference.trim();
  if (!trimmed || trimmed.startsWith("#") || /^(?:data|blob|javascript|mailto|tel):/i.test(trimmed)) {
    return null;
  }
  if (base.kind === "http") {
    let url: URL;
    try {
      url = new URL(trimmed, base.url);
    } catch {
      return null;
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !isLoopbackHostname(url.hostname) ||
      url.origin !== base.rootOrigin ||
      url.username || url.password
    ) {
      return null;
    }
    url.hash = "";
    return { ...base, url };
  }

  if (/^https?:\/\//i.test(trimmed)) return null;
  let candidate: string;
  try {
    candidate = /^file:/i.test(trimmed)
      ? fileURLToPath(trimmed)
      : path.resolve(path.dirname(base.filePath), decodeURIComponent(trimmed.split(/[?#]/, 1)[0] ?? ""));
  } catch {
    return null;
  }
  try {
    return {
      ...base,
      filePath: resolveWorkspaceFile(candidate, base.workspaceRoot),
    };
  } catch {
    return null;
  }
}

function sourceTarget(source: PreviewSource): string {
  return source.kind === "http" ? source.url.toString() : pathToFileURL(source.filePath).toString();
}

async function rewriteHtml(
  html: string,
  resource: CapturedResource,
  ensureResource: (source: PreviewSource) => Promise<string>,
): Promise<string> {
  const tagExpression = /<(a|link|script|img|source|video|audio|iframe|embed|object)\b[^>]*>/gi;
  return await replaceAsync(html, tagExpression, async (tag, rawName) => {
    const tagName = rawName.toLowerCase();
    let rewritten = tag;
    const attributeNames = tagName === "a"
      ? ["href"]
      : tagName === "link"
        ? ["href"]
        : tagName === "object"
          ? ["data"]
          : ["src", "poster"];

    for (const attributeName of attributeNames) {
      const attributeExpression = new RegExp(`(\\b${attributeName}\\s*=\\s*)(["'])(.*?)\\2`, "i");
      const match = attributeExpression.exec(rewritten);
      if (!match?.[3]) continue;
      const targetSource = resolveReference(match[3], resource.source);
      if (!targetSource) continue;
      if (tagName === "a") {
        const href = `/preview/open?target=${encodeURIComponent(sourceTarget(targetSource))}`;
        rewritten = rewritten.replace(attributeExpression, `$1$2${href}$2`);
        if (!/\btarget\s*=/i.test(rewritten)) {
          rewritten = rewritten.replace(/>$/, ' target="_blank" rel="noreferrer">');
        }
        continue;
      }
      try {
        const outputPath = await ensureResource(targetSource);
        const relative = relativeAssetPath(resource.outputPath, outputPath);
        rewritten = rewritten.replace(attributeExpression, `$1$2${relative}$2`);
      } catch {
        // Keep an unavailable optional resource unchanged instead of failing the page.
      }
    }

    if (/\bsrcset\s*=/i.test(rewritten)) {
      rewritten = await replaceAsync(
        rewritten,
        /(\bsrcset\s*=\s*)(["'])(.*?)\2/gi,
        async (_full, prefix, quote, value) => {
          const parts = await Promise.all(value.split(",").map(async (candidate) => {
            const trimmed = candidate.trim();
            const separator = trimmed.search(/\s/);
            const reference = separator >= 0 ? trimmed.slice(0, separator) : trimmed;
            const descriptor = separator >= 0 ? trimmed.slice(separator) : "";
            const targetSource = resolveReference(reference, resource.source);
            if (!targetSource) return trimmed;
            try {
              const outputPath = await ensureResource(targetSource);
              return `${relativeAssetPath(resource.outputPath, outputPath)}${descriptor}`;
            } catch {
              return trimmed;
            }
          }));
          return `${prefix}${quote}${parts.join(", ")}${quote}`;
        },
      );
    }
    return rewritten;
  });
}

async function rewriteCss(
  css: string,
  resource: CapturedResource,
  ensureResource: (source: PreviewSource) => Promise<string>,
): Promise<string> {
  let rewritten = await replaceAsync(
    css,
    /url\(\s*(["']?)(.*?)\1\s*\)/gi,
    async (full, _quote, reference) => {
      const targetSource = resolveReference(reference, resource.source);
      if (!targetSource) return full;
      try {
        const outputPath = await ensureResource(targetSource);
        return `url("${relativeAssetPath(resource.outputPath, outputPath)}")`;
      } catch {
        return full;
      }
    },
  );
  rewritten = await replaceAsync(
    rewritten,
    /@import\s+(["'])(.*?)\1/gi,
    async (full, quote, reference) => {
      const targetSource = resolveReference(reference, resource.source);
      if (!targetSource) return full;
      try {
        const outputPath = await ensureResource(targetSource);
        return `@import ${quote}${relativeAssetPath(resource.outputPath, outputPath)}${quote}`;
      } catch {
        return full;
      }
    },
  );
  return rewritten;
}

async function rewriteJavaScript(
  javascript: string,
  resource: CapturedResource,
  ensureResource: (source: PreviewSource) => Promise<string>,
): Promise<string> {
  const expressions = [
    /(\bfrom\s*)(["'])([^"']+)\2/g,
    /(\bimport\s*)(["'])([^"']+)\2/g,
    /(\bimport\s*\(\s*)(["'])([^"']+)\2(\s*\))/g,
    /(\bnew\s+URL\s*\(\s*)(["'])([^"']+)\2(\s*,\s*import\.meta\.url\s*\))/g,
  ];
  let rewritten = javascript;
  for (const expression of expressions) {
    rewritten = await replaceAsync(
      rewritten,
      expression,
      async (full, prefix, quote, reference, suffix) => {
        const targetSource = resolveReference(reference, resource.source);
        if (!targetSource) return full;
        try {
          const outputPath = await ensureResource(targetSource);
          return `${prefix}${quote}${relativeAssetPath(resource.outputPath, outputPath)}${quote}${suffix ?? ""}`;
        } catch {
          return full;
        }
      },
    );
  }
  return rewritten;
}

export async function createLocalPreviewPackage(
  target: string,
  options: CreateLocalPreviewPackageOptions,
): Promise<LocalPreviewPackage> {
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
  const rootSource = parseRootSource(target, workspaceRoot);
  const now = options.now ?? (() => Date.now());
  const context: CaptureContext = {
    fetchImpl: options.fetchImpl ?? fetch,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    rawBytes: 0,
    resources: new Map(),
    onProgress: options.onProgress ?? (() => undefined),
  };
  context.onProgress({ progress: 12, message: "正在读取本地页面和资源" });

  const ensureResource = async (
    source: PreviewSource,
    entry = false,
  ): Promise<string> => {
    const key = sourceKey(source);
    const existing = context.resources.get(key);
    if (existing) return existing.outputPath;
    if (context.resources.size >= context.maxFiles) {
      throw new LocalPreviewError(413, "本地页面引用的文件过多，无法部署到手机预览。");
    }

    const placeholderType = contentTypeFromPath(sourcePathname(source));
    const resource: CapturedResource = {
      source,
      outputPath: entry
        ? (isHtml(placeholderType) ? "index.html" : `index${path.extname(sourcePathname(source)) || extensionForContentType(placeholderType)}`)
        : safeOutputName(source, placeholderType),
      contentType: placeholderType,
      body: Buffer.alloc(0),
    };
    context.resources.set(key, resource);
    resource.processing = (async () => {
      const loaded = source.kind === "http"
        ? await fetchHttpSource(source, context)
        : readFileSource(source, context);
      resource.source = loaded.effectiveSource;
      resource.contentType = loaded.contentType;
      if (!entry) {
        resource.outputPath = safeOutputName(resource.source, resource.contentType);
      } else if (isHtml(resource.contentType)) {
        resource.outputPath = "index.html";
      } else {
        const extension = path.extname(sourcePathname(resource.source)) ||
          extensionForContentType(resource.contentType);
        resource.outputPath = `index${extension}`;
      }
      context.rawBytes += loaded.body.length;
      if (context.rawBytes > context.maxTotalBytes) {
        throw new LocalPreviewError(413, "本地页面资源总量过大，无法部署到手机预览。");
      }
      const completedRatio = context.resources.size / context.maxFiles;
      context.onProgress({
        progress: Math.min(72, 18 + Math.round(completedRatio * 54)),
        message: context.resources.size > 1
          ? `正在收集页面资源（${context.resources.size} 个）`
          : "正在读取本地页面和资源",
      });

      if (isHtml(resource.contentType)) {
        resource.body = Buffer.from(
          await rewriteHtml(loaded.body.toString("utf8"), resource, ensureResource),
        );
      } else if (isCss(resource.contentType)) {
        resource.body = Buffer.from(
          await rewriteCss(loaded.body.toString("utf8"), resource, ensureResource),
        );
      } else if (isJavaScript(resource.contentType)) {
        resource.body = Buffer.from(
          await rewriteJavaScript(loaded.body.toString("utf8"), resource, ensureResource),
        );
      } else {
        resource.body = loaded.body;
      }
    })();
    await resource.processing;
    return resource.outputPath;
  };

  const entryPath = await ensureResource(rootSource, true);
  await Promise.all([...context.resources.values()].map((resource) => resource.processing));
  context.onProgress({ progress: 82, message: "正在整理可在手机打开的版本" });

  const files = [...context.resources.values()].map((resource) => ({
    path: resource.outputPath,
    contentType: resource.contentType,
    bodyBase64: resource.body.toString("base64"),
  }));
  const totalBytes = files.reduce(
    (total, file) => total + Buffer.byteLength(file.bodyBase64, "base64"),
    0,
  );
  context.onProgress({ progress: 90, message: "正在部署到服务器上，以方便手机预览" });
  return {
    version: 1,
    deploymentId: `preview-${crypto.randomUUID()}`,
    sourceLabel: sourceLabel(rootSource),
    entryPath,
    createdAtMs: now(),
    totalBytes,
    files,
  };
}

export type EphemeralLocalPreviewStoreOptions = {
  ttlMs?: number;
  maxDeployments?: number;
  maxBytes?: number;
  now?: () => number;
};

export type StoredLocalPreviewContent = {
  body: Buffer;
  contentType: string;
  cacheControl: "no-store";
  contentSecurityPolicy: string;
};

type StoredDeployment = {
  deployment: LocalPreviewPackage;
  expiresAtMs: number;
};

function normalizeStoredPath(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  const normalized = path.posix.normalize(decoded.replace(/^\/+/, ""));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  return normalized;
}

export class EphemeralLocalPreviewStore {
  private readonly ttlMs: number;
  private readonly maxDeployments: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly deployments = new Map<string, StoredDeployment>();

  constructor(options: EphemeralLocalPreviewStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_STORE_TTL_MS;
    this.maxDeployments = options.maxDeployments ?? DEFAULT_STORE_MAX_DEPLOYMENTS;
    this.maxBytes = options.maxBytes ?? DEFAULT_STORE_MAX_BYTES;
    this.now = options.now ?? (() => Date.now());
  }

  put(deployment: LocalPreviewPackage): void {
    this.clean();
    if (
      !isLocalPreviewPackage(deployment) ||
      deployment.totalBytes > this.maxBytes
    ) {
      throw new LocalPreviewError(413, "手机预览部署包无效或过大。");
    }
    this.deployments.delete(deployment.deploymentId);
    this.deployments.set(deployment.deploymentId, {
      deployment,
      expiresAtMs: this.now() + this.ttlMs,
    });
    while (
      this.deployments.size > this.maxDeployments ||
      this.totalBytes() > this.maxBytes
    ) {
      const oldest = this.deployments.keys().next().value as string | undefined;
      if (!oldest) break;
      this.deployments.delete(oldest);
    }
  }

  entryPath(deploymentId: string): string | null {
    const stored = this.getDeployment(deploymentId);
    return stored?.deployment.entryPath ?? null;
  }

  sourceLabel(deploymentId: string): string | null {
    const stored = this.getDeployment(deploymentId);
    return stored?.deployment.sourceLabel ?? null;
  }

  read(deploymentId: string, requestedPath: string): StoredLocalPreviewContent | null {
    const stored = this.getDeployment(deploymentId);
    const normalizedPath = normalizeStoredPath(requestedPath);
    if (!stored || !normalizedPath) return null;
    const file = stored.deployment.files.find((candidate) =>
      normalizeStoredPath(candidate.path) === normalizedPath
    );
    if (!file) return null;
    let body: Buffer;
    try {
      body = Buffer.from(file.bodyBase64, "base64");
    } catch {
      return null;
    }
    return {
      body,
      contentType: file.contentType,
      cacheControl: "no-store",
      contentSecurityPolicy: PREVIEW_CONTENT_SECURITY_POLICY,
    };
  }

  private getDeployment(deploymentId: string): StoredDeployment | null {
    this.clean();
    const stored = this.deployments.get(deploymentId) ?? null;
    if (!stored) return null;
    this.deployments.delete(deploymentId);
    this.deployments.set(deploymentId, stored);
    return stored;
  }

  private clean(): void {
    const nowMs = this.now();
    for (const [deploymentId, stored] of this.deployments) {
      if (stored.expiresAtMs <= nowMs) {
        this.deployments.delete(deploymentId);
      }
    }
  }

  private totalBytes(): number {
    let total = 0;
    for (const stored of this.deployments.values()) {
      total += stored.deployment.totalBytes;
    }
    return total;
  }
}
