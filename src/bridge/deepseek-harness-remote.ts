/** DSH 2.0.9's multiplexed Typert stream carrier (not the legacy events RPC). */
import { randomUUID } from "node:crypto";
import { createDeepSeekSocket, type DeepSeekSocket } from "./deepseek-harness-socket.ts";

function websocketFailureMessage(event: Event, phase: "连接" | "关闭"): string {
  const error = event as Event & { error?: { message?: unknown; cause?: { code?: unknown } } };
  const detail = typeof error.error?.message === "string" ? error.error.message.trim() : "";
  const code = typeof error.error?.cause?.code === "string" ? error.error.cause.code : "";
  if (detail) return `DeepSeek Harness WebSocket ${phase}失败：${detail}`;
  if (code) return `DeepSeek Harness WebSocket ${phase}失败（网络错误 ${code}）。`;
  return `DeepSeek Harness WebSocket ${phase}失败，请检查 DSH Desktop 是否仍在运行。`;
}

function websocketCloseMessage(event: CloseEvent): string {
  const code = Number.isFinite(event.code) && event.code > 0 ? `（代码 ${event.code}）` : "";
  return `DeepSeek Harness WebSocket 连接已关闭${code}，正在重连。`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type StreamInbox = {
  values: unknown[];
  ended: boolean;
  error?: Error;
  wake?: () => void;
};

export class DeepSeekHarnessRemoteMux {
  private socket: DeepSeekSocket | null = null;
  private connecting: Promise<DeepSeekSocket> | null = null;
  private waitingOpens = 0;
  private readonly streams = new Map<string, StreamInbox>();

  constructor(
    private readonly baseUrl: string,
    private readonly cookie: () => string | null,
    private readonly timeoutMs: number,
  ) {}

  private connect(): Promise<DeepSeekSocket> {
    if (this.connecting) return this.connecting;
    const url = new URL("/api/remote.mux", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const cookie = this.cookie();
    const socket = createDeepSeekSocket(url, cookie);
    this.socket = socket;
    const connecting = new Promise<DeepSeekSocket>((resolve, reject) => {
      const fail = (error: Error): void => {
        clearTimeout(timer);
        reject(error);
        if (this.socket !== socket) return;
        this.socket = null;
        this.connecting = null;
        for (const stream of this.streams.values()) {
          stream.error = error;
          stream.wake?.();
        }
        this.streams.clear();
      };
      const timer = setTimeout(() => {
        fail(new Error("DeepSeek Harness 事件连接超时。"));
        socket.close();
      }, this.timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(socket);
      }, { once: true });
      socket.addEventListener("error", (event) => fail(new Error(websocketFailureMessage(event, "连接"))), { once: true });
      socket.addEventListener("close", (event) => fail(new Error(websocketCloseMessage(event as CloseEvent))), { once: true });
      socket.addEventListener("message", (event) => {
        if (this.socket !== socket) return;
        try {
          const frame: unknown = JSON.parse(String((event as MessageEvent).data));
          if (!record(frame) || typeof frame.streamId !== "string") throw new Error("DeepSeek Harness 事件帧格式无效。");
          const stream = this.streams.get(frame.streamId);
          if (!stream) return;
          if (frame.type === "item") {
            if (stream.values.length >= 256) {
              stream.error = new Error("DeepSeek Harness 事件积压过多，正在重新同步。");
            } else stream.values.push(frame.value);
          } else if (frame.type === "end") stream.ended = true;
          else if (frame.type === "error") {
            const detail = record(frame.error) && typeof frame.error.message === "string"
              ? frame.error.message : "未知接口错误";
            stream.error = new Error(`DeepSeek Harness 事件读取失败：${detail}`);
          } else throw new Error("DeepSeek Harness 事件类型无效。");
          stream.wake?.();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          socket.close();
        }
      });
    });
    this.connecting = connecting;
    return connecting;
  }

  async *open(endpoint: string, payload: Record<string, unknown>, signal: AbortSignal): AsyncIterable<unknown> {
    signal.throwIfAborted();
    this.waitingOpens += 1;
    let socket: DeepSeekSocket;
    let abortOpening: (() => void) | undefined;
    try {
      socket = await Promise.race([
        this.connect(),
        new Promise<never>((_, reject) => {
          abortOpening = () => reject(signal.reason);
          signal.addEventListener("abort", abortOpening, { once: true });
          if (signal.aborted) abortOpening();
        }),
      ]);
      signal.throwIfAborted();
    } catch (error) {
      if (this.waitingOpens === 1 && this.streams.size === 0) {
        this.socket?.close();
        this.socket = null;
        this.connecting = null;
      }
      throw error;
    } finally {
      this.waitingOpens -= 1;
      if (abortOpening) signal.removeEventListener("abort", abortOpening);
    }
    const id = randomUUID();
    const inbox: StreamInbox = { values: [], ended: false };
    this.streams.set(id, inbox);
    const abort = (): void => {
      inbox.error = signal.reason instanceof Error ? signal.reason : new Error("DeepSeek Harness 事件读取已取消。");
      inbox.wake?.();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      socket.send(JSON.stringify({ type: "open", streamId: id, endpoint, payload }));
      while (true) {
        if (inbox.error) throw inbox.error;
        if (inbox.values.length) { yield inbox.values.shift(); continue; }
        if (inbox.ended) return;
        await new Promise<void>((resolve) => { inbox.wake = resolve; });
        inbox.wake = undefined;
      }
    } finally {
      signal.removeEventListener("abort", abort);
      this.streams.delete(id);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "cancel", streamId: id }));
      }
      if (this.waitingOpens === 0 && this.streams.size === 0 && this.socket === socket) {
        this.socket = null;
        this.connecting = null;
        socket.close();
      }
    }
  }
}
