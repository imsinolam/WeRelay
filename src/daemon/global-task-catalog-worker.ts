import { isMainThread, parentPort, Worker } from "node:worker_threads";

import { listLightweightAdapterSessions } from "./global-task-catalog.ts";
import type { BridgeResumeSessionCandidate } from "../bridge/bridge-types.ts";
import type { DaemonAdapterKind } from "../bridge/bridge-providers.ts";

type CatalogRequest = {
  id: number;
  adapter: DaemonAdapterKind;
  cwd: string;
  limit: number;
};
type CatalogResponse = {
  id: number;
  ok: boolean;
  candidates?: BridgeResumeSessionCandidate[];
  error?: string;
};

// Each adapter uses an isolated, idle-expiring worker; one slow catalog must
// never terminate the pending requests of other adapters. Several historical adapters still use synchronous directory,
// transcript, or SQLite reads; keeping them here prevents one slow catalog
// from blocking DSH's 2-second WebSocket heartbeat and WeChat polling.
if (!isMainThread && parentPort) {
  parentPort.on("message", async (request: CatalogRequest) => {
    try {
      const candidates = await listLightweightAdapterSessions(
        request.adapter,
        request.cwd,
        request.limit,
      );
      parentPort!.postMessage({ id: request.id, ok: true, candidates } satisfies CatalogResponse);
    } catch (error) {
      parentPort!.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies CatalogResponse);
    }
  });
}

type Pending = {
  resolve: (value: BridgeResumeSessionCandidate[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  adapter: DaemonAdapterKind;
};

type CatalogSlot = { worker: Worker; idleTimer?: ReturnType<typeof setTimeout> };

export class GlobalTaskCatalogWorker {
  private readonly workers = new Map<DaemonAdapterKind, CatalogSlot>();
  private closed = false;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly options: {
    timeoutMs?: number;
    workerFactory?: (url: URL) => Worker;
    idleMs?: number;
  } = {}) {}

  private fail(adapter: DaemonAdapterKind, worker: Worker, error: Error): void {
    const slot = this.workers.get(adapter);
    if (slot?.worker !== worker) return;
    clearTimeout(slot.idleTimer);
    this.workers.delete(adapter);
    for (const [id, pending] of this.pending) {
      if (pending.adapter !== adapter) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
    void worker.terminate();
  }

  private idle(adapter: DaemonAdapterKind, worker: Worker): void {
    if ([...this.pending.values()].some((item) => item.adapter === adapter)) return;
    const slot = this.workers.get(adapter);
    if (!slot || slot.worker !== worker) return;
    worker.unref();
    clearTimeout(slot.idleTimer);
    slot.idleTimer = setTimeout(() => {
      this.fail(adapter, worker, new Error("任务目录读取空闲，已释放后台资源。"));
    }, this.options.idleMs ?? 60_000);
    slot.idleTimer.unref();
  }

  private getWorker(adapter: DaemonAdapterKind): Worker {
    const existing = this.workers.get(adapter);
    if (existing) {
      clearTimeout(existing.idleTimer);
      return existing.worker;
    }
    const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const url = new URL(`./global-task-catalog-worker${extension}`, import.meta.url);
    const worker = this.options.workerFactory?.(url) ?? new Worker(url, {
      execArgv: process.execArgv.filter((arg, index, args) =>
        !/^--input-type(?:=|$)/u.test(arg) && args[index - 1] !== "--input-type"),
    });
    worker.on("message", (response: CatalogResponse) => {
      if (this.workers.get(adapter)?.worker !== worker) return;
      const pending = this.pending.get(response.id);
      if (!pending || pending.adapter !== adapter) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      this.idle(adapter, worker);
      if (response.ok) pending.resolve(response.candidates ?? []);
      else pending.reject(new Error(response.error || "任务目录读取失败。"));
    });
    worker.on("error", (error) => this.fail(adapter, worker, error));
    worker.on("exit", (code) => this.fail(adapter, worker, new Error(
      `任务目录后台读取进程已退出（代码 ${code}）。`,
    )));
    this.workers.set(adapter, { worker });
    worker.unref();
    return worker;
  }

  async load(adapter: DaemonAdapterKind, cwd: string, limit = 100): Promise<BridgeResumeSessionCandidate[]> {
    if (this.closed) throw new Error("任务目录后台读取已停止。");
    if (this.pending.size >= 32) throw new Error("任务目录读取繁忙，请稍后重试。");
    const worker = this.getWorker(adapter);
    const id = ++this.nextId;
    return await new Promise<BridgeResumeSessionCandidate[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(adapter, worker, new Error("任务目录后台读取超时，稍后将重新连接。"));
      }, this.options.timeoutMs ?? 6_000);
      worker.ref();
      this.pending.set(id, { resolve, reject, timer, adapter });
      try {
        worker.postMessage({ id, adapter, cwd, limit } satisfies CatalogRequest);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        this.idle(adapter, worker);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [adapter, slot] of this.workers) {
      this.fail(adapter, slot.worker, new Error("任务目录后台读取已停止。"));
    }
  }
}
