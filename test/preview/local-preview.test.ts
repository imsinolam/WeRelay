import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  createLocalPreviewPackage,
  EphemeralLocalPreviewStore,
  LocalPreviewError,
} from "../../src/preview/local-preview.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function startHttpFixture(
  handler: http.RequestListener,
): Promise<{ baseUrl: string }> {
  const server = http.createServer(handler);
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("missing fixture address"));
        return;
      }
      resolve(address.port);
    });
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  });
  return { baseUrl: `http://127.0.0.1:${port}` };
}

describe("local preview capture", () => {
  test("rejects remote URLs and files outside the active workspace", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "deskrelay-preview-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "deskrelay-preview-outside-"));
    const outsideFile = path.join(outside, "secret.html");
    fs.writeFileSync(outsideFile, "<h1>secret</h1>");
    cleanups.push(() => {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    });

    await expect(createLocalPreviewPackage("https://example.com", {
      workspaceRoot: workspace,
    })).rejects.toBeInstanceOf(LocalPreviewError);
    await expect(createLocalPreviewPackage(outsideFile, {
      workspaceRoot: workspace,
    })).rejects.toMatchObject({ statusCode: 403 });
  });

  test("captures a loopback page and rewrites local HTML, CSS and module resources", async () => {
    const requested: string[] = [];
    const fixture = await startHttpFixture((request, response) => {
      const url = request.url ?? "/";
      requested.push(url);
      if (url === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html><head><link rel="stylesheet" href="/site.css"></head><body><img src="/hero.svg" srcset="/hero.svg 1x, /hero-2.svg 2x"><script type="module" src="/app.js"></script><a href="/next.html">下一页</a></body></html>`);
        return;
      }
      if (url === "/site.css") {
        response.writeHead(200, { "content-type": "text/css" });
        response.end("body{background-image:url('/bg.png')}");
        return;
      }
      if (url === "/app.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end("import { value } from './chunk.js'; document.body.dataset.value = value;");
        return;
      }
      if (url === "/chunk.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end("export const value = 'fresh';");
        return;
      }
      if (url === "/hero.svg" || url === "/hero-2.svg") {
        response.writeHead(200, { "content-type": "image/svg+xml" });
        response.end("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
        return;
      }
      if (url === "/bg.png") {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(Buffer.from([137, 80, 78, 71]));
        return;
      }
      response.writeHead(404).end();
    });

    const deployment = await createLocalPreviewPackage(fixture.baseUrl, {
      workspaceRoot: process.cwd(),
    });
    const entry = deployment.files.find((file) => file.path === deployment.entryPath);
    const html = Buffer.from(entry?.bodyBase64 ?? "", "base64").toString("utf8");
    const css = deployment.files
      .filter((file) => file.contentType.startsWith("text/css"))
      .map((file) => Buffer.from(file.bodyBase64, "base64").toString("utf8"))
      .join("\n");
    const scripts = deployment.files
      .filter((file) => file.contentType.includes("javascript"))
      .map((file) => Buffer.from(file.bodyBase64, "base64").toString("utf8"))
      .join("\n");

    expect(requested).toEqual(expect.arrayContaining([
      "/",
      "/site.css",
      "/app.js",
      "/chunk.js",
      "/hero.svg",
      "/hero-2.svg",
      "/bg.png",
    ]));
    expect(requested).not.toContain("/next.html");
    expect(html).not.toContain(`${fixture.baseUrl}/site.css`);
    expect(html).toContain("/preview/open?target=");
    expect(css).not.toContain("/bg.png");
    expect(scripts).not.toContain("./chunk.js");
    expect(deployment.totalBytes).toBeGreaterThan(0);
  });

  test("captures an HTML file and only reads referenced files inside the workspace", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "deskrelay-preview-files-"));
    fs.mkdirSync(path.join(workspace, "assets"));
    fs.writeFileSync(
      path.join(workspace, "index.html"),
      '<link rel="stylesheet" href="./assets/site.css"><h1>本地文件</h1>',
    );
    fs.writeFileSync(path.join(workspace, "assets", "site.css"), "h1{color:#123456}");
    fs.writeFileSync(path.join(workspace, ".env"), "SHOULD_NOT_BE_PACKAGED=1");
    cleanups.push(() => fs.rmSync(workspace, { recursive: true, force: true }));

    const deployment = await createLocalPreviewPackage(
      path.join(workspace, "index.html"),
      { workspaceRoot: workspace },
    );
    const bodies = deployment.files.map((file) =>
      Buffer.from(file.bodyBase64, "base64").toString("utf8")
    );
    expect(bodies.join("\n")).toContain("本地文件");
    expect(bodies.join("\n")).toContain("#123456");
    expect(bodies.join("\n")).not.toContain("SHOULD_NOT_BE_PACKAGED");
  });
});

describe("ephemeral local preview store", () => {
  test("expires deployments and returns sandboxed no-store content", () => {
    let nowMs = 1_800_000_000_000;
    const store = new EphemeralLocalPreviewStore({
      now: () => nowMs,
      ttlMs: 1_000,
    });
    store.put({
      version: 1,
      deploymentId: "preview-1",
      sourceLabel: "index.html",
      entryPath: "index.html",
      createdAtMs: nowMs,
      totalBytes: Buffer.byteLength("<h1>ok</h1>"),
      files: [{
        path: "index.html",
        contentType: "text/html; charset=utf-8",
        bodyBase64: Buffer.from("<h1>ok</h1>").toString("base64"),
      }],
    });

    expect(store.read("preview-1", "index.html")).toMatchObject({
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-store",
      contentSecurityPolicy: expect.stringContaining("sandbox"),
    });
    nowMs += 1_001;
    expect(store.read("preview-1", "index.html")).toBeNull();
  });
});
