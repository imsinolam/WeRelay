import { describe, expect, test } from "bun:test";
import { DeepSeekHarnessHttpClient } from "../../src/bridge/bridge-adapters.deepseek.ts";

function host(failFollow = false) {
  let eventSocket: Bun.ServerWebSocket<unknown> | undefined;
  let eventStreamId = "";
  const calls: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
  const streams: string[] = [];
  let closed = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      const endpoint = new URL(request.url).pathname.replace("/api/", "");
      if (endpoint === "remote.mux") {
        if (server.upgrade(request)) return;
        return new Response("upgrade required", { status: 400 });
      }
      const body = await request.json();
      calls.push({ endpoint, payload: body.payload });
      const req = body.payload?.args?.request;
      let value: unknown;
      if (endpoint === "session/list") {
        // Cold persisted tasks do not necessarily have a projection cursor.
        value = { items: [{ sessionId: "s1", updatedAt: 1, running: false, blank: false }] };
      } else if (endpoint === "session/modelCatalog") {
        value = { default: { provider: "global-provider", model: "default-model" }, routableProviders: ["session-provider"], groups: [], failures: [] };
      } else if (endpoint === "session/prompt") {
        if (!req?.requestId || req.requestId !== body.rpcId) return new Response("missing requestId", { status: 400 });
        value = { accepted: true };
      } else if (endpoint === "session/page") {
        if (req?.throughSeq !== 8 || req.beforeSeq !== 5) return new Response("invalid cursor", { status: 400 });
        value = { records: [{ type: "event", event: { type: "user/message", seq: 4, time: 1, data: {} } }], hasMore: true };
      } else if (endpoint === "$events/result") {
        if (body.payload.args.clientId !== "client-1" || body.payload.args.eventId !== "approval-1") {
          return new Response("invalid event result", { status: 400 });
        }
        value = undefined;
      }
      else return new Response("not found", { status: 404 });
      return Response.json({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value } });
    },
    websocket: {
      message(socket, text) {
        const request = JSON.parse(String(text));
        if (request.type !== "open") return;
        streams.push(request.endpoint);
        const item = (value: unknown) => socket.send(JSON.stringify({ type: "item", streamId: request.streamId, value }));
        if (request.endpoint === "session/follow") {
          if (failFollow) { socket.terminate(); return; }
          item({ type: "snapshot", cursor: 8, hasMore: false, projections: { values: { modelSelection: { next: { provider: "session-provider", model: "session-model", reasoningEffort: "high" } } } }, records: [
            { type: "event", event: { type: "assistant/message", seq: 8, time: 1, data: { message: { content: [{ type: "text", text: "真实回复" }] } } } },
          ] });
        } else if (request.endpoint === "$events") {
          eventSocket = socket; eventStreamId = request.streamId;
          item({ type: "ready", clientId: "client-1" });
          item({ type: "waterfall", event: "approval/request", eventId: "approval-1", agentId: "s1", request: { toolName: "git_commit", reason: "保存修复" } });
        }
      },
      close() { closed += 1; },
    },
  });
  return { server, calls, streams,
    emitSessionEvent: () => eventSocket?.send(JSON.stringify({ type: "item", streamId: eventStreamId, value: { type: "emit", event: "api-session/updated", args: ["s1"] } })),
    closed: () => closed, client: new DeepSeekHarnessHttpClient(`http://127.0.0.1:${server.port}`, fetch, 1_000, null, () => null) };
}

describe("DeepSeek Harness 2.0.9 real wire contract", () => {
  test("prompt includes the same stable requestId inside the Typert request", async () => {
    const h = host();
    try {
      expect(await h.client.prompt("s1", [{ type: "text", text: "测试" }], "once-1"))
        .toEqual({ rpcId: "once-1", value: { accepted: true } });
      expect(h.calls.find(c => c.endpoint === "session/prompt")?.payload)
        .toMatchObject({ args: { request: { requestId: "once-1", sessionId: "s1" } } });
    } finally { h.server.stop(true); }
  });

  test("cold task history comes from a native follow snapshot, not an absent projection cursor", async () => {
    const h = host();
    try {
      const history = await h.client.readHistory("s1", { maxMessages: 3 });
      expect(history.events.map(e => e.event.seq)).toEqual([8]);
      expect(h.streams).toContain("session/follow");
      expect(h.calls.some(c => c.endpoint === "session/page")).toBe(false);
    } finally { h.server.stop(true); }
  });

  test("model menu reflects the selected session rather than a global catalog default", async () => {
    const h = host();
    try {
      const state = await h.client.readModels("s1");
      expect(state.current).toEqual({ provider: "session-provider", model: "session-model", reasoningEffort: "high" });
      expect(state.routable).toBe(true);
    } finally { h.server.stop(true); }
  });

  test("historical page keeps throughSeq separate from exclusive beforeSeq", async () => {
    const h = host();
    try {
      const history = await h.client.readHistory("s1", { beforeSeq: 5, maxMessages: 3 });
      expect(history.events.map(e => e.event.seq)).toEqual([4]);
    } finally { h.server.stop(true); }
  });

  test("opens the Typert event stream and answers approvals through its own result endpoint", async () => {
    const h = host();
    const abort = new AbortController();
    const stream = h.client.openMux(abort.signal)[Symbol.asyncIterator]();
    try {
      const first = await stream.next();
      expect(first.value?.payload.type).toBe("stream/ready");
      const approval = await stream.next();
      expect(approval.value?.payload).toMatchObject({ type: "approval/requested", sessionId: "s1", toolName: "git_commit" });
      expect(await h.client.respond({ type: "client-response", rpcId: approval.value!.rpcId, result: { ok: true, value: { outcome: "allowed-once" } } }))
        .toEqual({ accepted: true });
      expect(h.calls.find(c => c.endpoint === "$events/result")?.payload).toEqual({ args: {
        clientId: "client-1", eventId: "approval-1", outcome: { kind: "result", value: "allowed-once" },
      } });
    } finally { abort.abort(); await stream.return?.(); h.server.stop(true); }
  }, 3_000);
});

 test("history socket failure must not disconnect approval/event delivery", async () => {
   const h = host(true);
   const controller = new AbortController();
   const it = h.client.openMux(controller.signal);
   try {
     expect((await it.next()).value?.payload.type).toBe("stream/ready");
     expect((await it.next()).value?.payload.type).toBe("approval/requested");
     const event = it.next().catch((e: Error) => e.message);
     await expect(h.client.readHistory("s1", { maxMessages: 3 })).rejects.toThrow();
     h.emitSessionEvent();
     const result = await Promise.race([event, new Promise<string>(resolve => setTimeout(() => resolve("event timed out"), 1000))]);
     expect(typeof result).toBe("object");
     expect((result as IteratorResult<unknown>).done).toBe(false);
   } finally { controller.abort(); await it.return(undefined).catch(() => {}); h.server.stop(true); }
 }, 4000);
