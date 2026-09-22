import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { expect, test } from "bun:test";
import { GlobalTaskCatalogWorker } from "../../src/daemon/global-task-catalog-worker.ts";

class FakeWorker extends EventEmitter {
  terminated = false;
  requests: { id: number }[] = [];
  ref() { return this; }
  unref() { return this; }
  postMessage(value: { id: number }) { this.requests.push(value); }
  async terminate() { this.terminated = true; return 0; }
}

test("catalog requests have a deadline and a timed-out worker is replaced", async () => {
  const workers: FakeWorker[] = [];
  const catalog = new GlobalTaskCatalogWorker({
    timeoutMs: 20,
    workerFactory: () => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker; },
  });
  try {
    await expect(catalog.load("grok", "/tmp")).rejects.toThrow("超时");
    expect(workers[0]?.terminated).toBe(true);
    const next = catalog.load("grok", "/tmp");
    workers[0]!.emit("exit", 1);
    const w = workers[1]!;
    w.emit("message", { id: w.requests[0]!.id, ok: true, candidates: [] });
    expect(await next).toEqual([]);
  } finally { await catalog.close(); }
});

test("catalog worker uses the source extension and does not inherit eval-only flags", async () => {
  let url: URL | undefined;
  const worker = new FakeWorker();
  const catalog = new GlobalTaskCatalogWorker({ workerFactory: (value) => { url = value; return worker as unknown as Worker; } });
  const task = catalog.load("grok", "/tmp");
  try {
    expect(url?.pathname.endsWith(".ts")).toBe(true);
    worker.emit("message", { id: worker.requests[0]!.id, ok: true, candidates: [] });
    expect(await task).toEqual([]);
  } finally { await catalog.close(); await task.catch(() => undefined); }
});

test("catalog close rejects pending requests and prevents a new worker during shutdown", async () => {
  const w = new FakeWorker();
  const catalog = new GlobalTaskCatalogWorker({ workerFactory: () => w as unknown as Worker });
  const result = catalog.load("grok", "/tmp").catch((e: Error) => e.message);
  await catalog.close();
  expect(await result).toContain("停止");
  await expect(catalog.load("grok", "/tmp")).rejects.toThrow("停止");
});

test("catalog bounds pending work instead of accumulating requests indefinitely", async () => {
  const w = new FakeWorker();
  const catalog = new GlobalTaskCatalogWorker({ workerFactory: () => w as unknown as Worker });
  const tasks = Array.from({ length: 32 }, () => catalog.load("grok", "/tmp").catch(() => []));
  await expect(catalog.load("grok", "/tmp")).rejects.toThrow("繁忙");
  await catalog.close();
  await Promise.all(tasks);
});

test("real source worker starts under Node eval and lets an idle process exit", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-global-worker-"));
  try {
    const source = new URL("../../src/daemon/global-task-catalog-worker.ts", import.meta.url).href;
    const code = `import {GlobalTaskCatalogWorker} from ${JSON.stringify(source)}; const c=new GlobalTaskCatalogWorker(); console.log(JSON.stringify(await c.load("grok",${JSON.stringify(dir)})));`;
    const { stdout } = await promisify(execFile)("node", ["--experimental-transform-types", "--input-type=module", "-e", code], {
      env: { ...process.env, HOME: dir }, timeout: 8_000,
    });
    expect(JSON.parse(stdout.trim())).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 10_000);

 test("one slow terminal cannot terminate another terminal's pending catalog", async () => {
   const workers: FakeWorker[] = [];
   const catalog = new GlobalTaskCatalogWorker({ timeoutMs: 80,
     workerFactory: () => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker; },
   });
   try {
     const slow = catalog.load("codebuddy", "/tmp").catch((e: Error) => e.message);
     await new Promise(r => setTimeout(r, 40));
     const fast = catalog.load("deepseek", "/tmp");
     const result = fast.catch((e: Error) => e.message);
     await slow;
     expect(workers).toHaveLength(2);
     expect(workers[1]!.terminated).toBe(false);
     workers[1]!.emit("message", { id: workers[1]!.requests[0]!.id, ok: true, candidates: [] });
     expect(await result).toEqual([]);
   } finally { await catalog.close(); }
 });
