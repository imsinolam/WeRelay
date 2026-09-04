import { afterEach, describe, expect, test } from "bun:test";
import http from "node:http";

import {
  createLocalPreviewOpenHtml,
  createLocalPreviewViewerHtml,
} from "../../src/preview/local-preview-web.ts";
import {
  LocalPreviewJobManager,
} from "../../src/preview/local-preview-jobs.ts";
import { EphemeralLocalPreviewStore } from "../../src/preview/local-preview.ts";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function startChangingPage(): Promise<{
  baseUrl: string;
  setVersion: (value: string) => void;
}> {
  let version = "第一版";
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<h1>${version}</h1>`);
  });
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
  closers.push(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    setVersion: (value) => { version = value; },
  };
}

async function waitForReady(manager: LocalPreviewJobManager, jobId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = manager.read(jobId, { includePackage: true });
    if (status?.status === "ready") return status;
    if (status?.status === "failed") throw new Error(status.error);
    await Bun.sleep(10);
  }
  throw new Error("preview job timed out");
}

describe("local preview deployment jobs", () => {
  test("creates a new deployment for every open and captures the latest page", async () => {
    const fixture = await startChangingPage();
    const store = new EphemeralLocalPreviewStore();
    const manager = new LocalPreviewJobManager({
      workspaceRoot: process.cwd(),
      store,
    });

    const firstJob = manager.create(fixture.baseUrl);
    const first = await waitForReady(manager, firstJob.jobId);
    const firstBody = store.read(
      first.deploymentId ?? "",
      first.entryPath ?? "",
    )?.body.toString("utf8");
    expect(firstBody).toContain("第一版");
    expect(first.previewPackage?.deploymentId).toBe(first.deploymentId);

    fixture.setVersion("第二版");
    const secondJob = manager.create(fixture.baseUrl);
    const second = await waitForReady(manager, secondJob.jobId);
    const secondBody = store.read(
      second.deploymentId ?? "",
      second.entryPath ?? "",
    )?.body.toString("utf8");

    expect(second.jobId).not.toBe(first.jobId);
    expect(second.deploymentId).not.toBe(first.deploymentId);
    expect(secondBody).toContain("第二版");
    expect(second.readyUrl).toBe(`/preview/view/${second.deploymentId}`);
  });

  test("bounds concurrent captures while keeping later opens queued", async () => {
    let active = 0;
    let maxActive = 0;
    const manager = new LocalPreviewJobManager({
      workspaceRoot: process.cwd(),
      store: new EphemeralLocalPreviewStore(),
      maxConcurrentJobs: 2,
      fetchImpl: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(30);
        active -= 1;
        return new Response("<h1>queued preview</h1>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    });
    const jobs = Array.from({ length: 5 }, (_, index) =>
      manager.create(`http://127.0.0.1:${18000 + index}/`)
    );

    expect(manager.read(jobs[4]?.jobId ?? "")?.status).toBe("queued");
    await Promise.all(jobs.map((job) => waitForReady(manager, job.jobId)));
    expect(maxActive).toBe(2);
  });

  test("reports an actionable failure for a forbidden target", async () => {
    const manager = new LocalPreviewJobManager({
      workspaceRoot: process.cwd(),
      store: new EphemeralLocalPreviewStore(),
    });
    const job = manager.create("https://example.com/private");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = manager.read(job.jobId);
      if (status?.status === "failed") {
        expect(status.progress).toBe(100);
        expect(status.error).toContain("回环地址");
        return;
      }
      await Bun.sleep(5);
    }
    throw new Error("forbidden preview job did not fail");
  });
});

describe("local preview pages", () => {
  test("shows deployment progress and automatically opens the ready page", () => {
    const html = createLocalPreviewOpenHtml("test-preview-nonce");
    expect(html).toContain("正在部署到服务器上，以方便手机预览");
    expect(html).toContain('fetch("/api/previews/jobs"');
    expect(html).toContain('location.replace(payload.readyUrl)');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('nonce="test-preview-nonce"');
    expect(html).toContain("重新部署");
  });

  test("renders the deployed page inside an isolated full-screen viewer", () => {
    const html = createLocalPreviewViewerHtml({
      nonce: "test-viewer-nonce",
      deploymentId: "preview-123",
      entryPath: "index.html",
      sourceLabel: "127.0.0.1:17800/",
    });
    expect(html).toContain('sandbox="allow-scripts allow-downloads allow-popups allow-modals"');
    expect(html).toContain('nonce="test-viewer-nonce"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).toContain("/preview/content/preview-123/index.html");
    expect(html).toContain("127.0.0.1:17800/");
  });
});
