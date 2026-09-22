import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

/** Keep DSH Ping/Pong processing off the daemon's parsing/IO event loop. */
export interface DeepSeekSocket extends EventTarget {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
}

type Start = { kind: "deepseek-socket"; url: string; cookie: string | null };
type Command = { type: "send"; data: string } | { type: "close" } | { type: "ack"; id: number };
type Notice = { type: "open" } | { type: "message"; id: number; data: string }
  | { type: "error"; message: string } | { type: "close"; code: number; reason: string };
const MAX_PENDING_BYTES = 64 * 1024 * 1024;

if (!isMainThread && parentPort && (workerData as Start | undefined)?.kind === "deepseek-socket") {
  const port = parentPort;
  const config = workerData as Start;
  const socket = config.cookie
    ? new WebSocket(config.url, { headers: { cookie: config.cookie } } as never)
    : new WebSocket(config.url);
  let nextId = 0;
  let pendingBytes = 0;
  let closingTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<number, number>();
  const post = (notice: Notice): void => port.postMessage(notice);
  const close = (): void => {
    if (closingTimer) return;
    socket.close();
    closingTimer = setTimeout(() => process.exit(0), 1_000);
    closingTimer.unref();
  };
  socket.addEventListener("open", () => post({ type: "open" }));
  socket.addEventListener("message", (event) => {
    const data = String(event.data);
    const bytes = Buffer.byteLength(data);
    if (pendingBytes + bytes > MAX_PENDING_BYTES) {
      post({ type: "error", message: "DSH 事件数据积压超过上限，正在重新同步。" });
      close();
      return;
    }
    const id = ++nextId;
    pending.set(id, bytes);
    pendingBytes += bytes;
    post({ type: "message", id, data });
  });
  socket.addEventListener("error", (event) => {
    const error = (event as Event & { error?: Error; message?: string }).error;
    post({ type: "error", message: error?.message || "DSH WebSocket 传输失败。" });
    close();
  });
  socket.addEventListener("close", (event) => {
    clearTimeout(closingTimer);
    post({ type: "close", code: event.code, reason: event.reason });
    pending.clear();
    port.close();
  });
  port.on("message", (command: Command) => {
    if (command.type === "close") close();
    else if (command.type === "ack") {
      pendingBytes -= pending.get(command.id) ?? 0;
      pending.delete(command.id);
    } else if (socket.readyState === WebSocket.OPEN) socket.send(command.data);
  });
}

function workerExecArgv(): string[] {
  const result: string[] = [];
  const args = process.execArgv;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (["--input-type", "-e", "--eval", "-p", "--print"].includes(arg)) { i += 1; continue; }
    if (/^--(?:input-type|eval|print)=/.test(arg)) continue;
    result.push(arg);
  }
  return result;
}

class WorkerSocket extends EventTarget implements DeepSeekSocket {
  readyState = WebSocket.CONNECTING as number;
  private readonly worker: Worker;
  private closingTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(url: string, cookie: string | null) {
    super();
    const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    this.worker = new Worker(new URL(`./deepseek-harness-socket${extension}`, import.meta.url), {
      workerData: { kind: "deepseek-socket", url, cookie } satisfies Start,
      execArgv: workerExecArgv(),
    });
    this.worker.on("message", (notice: Notice) => {
      if (this.readyState === WebSocket.CLOSED) return;
      if (notice.type === "open") {
        if (this.readyState !== WebSocket.CONNECTING) return;
        this.readyState = WebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      } else if (notice.type === "message") {
        try { this.dispatchEvent(new MessageEvent("message", { data: notice.data })); }
        finally { this.worker.postMessage({ type: "ack", id: notice.id } satisfies Command); }
      } else if (notice.type === "error") {
        this.dispatchEvent(Object.assign(new Event("error"), { error: new Error(notice.message) }));
      } else this.finish(notice.code, notice.reason);
    });
    this.worker.on("error", (error) => {
      if (this.readyState === WebSocket.CLOSED) return;
      this.dispatchEvent(Object.assign(new Event("error"), { error }));
      this.finish(1006, "socket worker failed");
    });
    this.worker.on("exit", () => this.finish(1006, "socket worker exited"));
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    clearTimeout(this.closingTimer);
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason, wasClean: code === 1000 }));
    void this.worker.terminate();
  }

  send(data: string): void {
    if (this.readyState !== WebSocket.OPEN) throw new Error("DSH 事件连接尚未就绪。");
    this.worker.postMessage({ type: "send", data } satisfies Command);
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED || this.readyState === WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSING;
    this.worker.postMessage({ type: "close" } satisfies Command);
    this.closingTimer = setTimeout(() => this.finish(1006, "socket shutdown deadline"), 1_500);
    this.closingTimer.unref();
  }
}

export function createDeepSeekSocket(url: URL, cookie: string | null): DeepSeekSocket {
  return new WorkerSocket(url.href, cookie);
}
