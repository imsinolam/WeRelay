import { expect, test } from "bun:test";

// The server runs in Bun and the client in the production Node runtime. Blocking
// the client's main thread must not prevent control-frame pong responses.
test("DSH socket survives daemon main-thread stalls without missing server heartbeats", async () => {
  let missed = 0;
  let terminated = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("upgrade required", { status: 400 });
    },
    websocket: {
      open(socket) {
        heartbeat = setInterval(() => {
          if (missed >= 2) { terminated = true; socket.terminate(); return; }
          missed += 1;
          socket.ping();
        }, 70);
      },
      pong() { missed = 0; },
      message(socket, text) {
        const frame = JSON.parse(String(text));
        if (frame.type !== "open") return;
        socket.send(JSON.stringify({ type: "item", streamId: frame.streamId, value: "ready" }));
        readyTimer = setTimeout(() => {
          socket.send(JSON.stringify({ type: "item", streamId: frame.streamId, value: "survived" }));
        }, 700);
      },
      close() { clearInterval(heartbeat); },
    },
  });
  try {
    const moduleUrl = new URL("../../src/bridge/deepseek-harness-remote.ts", import.meta.url).href;
    const script = `
      const {DeepSeekHarnessRemoteMux} = await import(${JSON.stringify(moduleUrl)});
      const mux = new DeepSeekHarnessRemoteMux("http://127.0.0.1:${server.port}", () => null, 1500);
      const timer = setTimeout(() => process.exit(2), 4000);
      try {
        for await (const value of mux.open("test", {}, AbortSignal.timeout(2500))) {
          if (value === "ready") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 450);
          if (value === "survived") { console.log("survived"); break; }
        }
      } catch (error) { console.error(error.message); process.exitCode = 1; }
      clearTimeout(timer);
    `;
    const child = Bun.spawn(["node", "--experimental-transform-types", "--input-type=module", "-e", script], {
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ exit, stdout: stdout.trim(), terminated, error: exit ? stderr.trim() : "" })
      .toEqual({ exit: 0, stdout: "survived", terminated: false, error: "" });
  } finally {
    clearInterval(heartbeat);
    clearTimeout(readyTimer);
    server.stop(true);
  }
}, 8000);

test("DSH socket worker forwards authentication and closes without leaving a connection", async () => {
  const { createDeepSeekSocket } = await import("../../src/bridge/deepseek-harness-socket.ts");
  let authenticated = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      authenticated = request.headers.get("cookie") === "test=private";
      if (!authenticated) return new Response("unauthorized", { status: 401 });
      if (server.upgrade(request)) return;
      return new Response("upgrade required", { status: 400 });
    },
    websocket: { message() {} },
  });
  const socket = createDeepSeekSocket(new URL(`ws://127.0.0.1:${server.port}/`), "test=private");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
    });
    expect(authenticated).toBe(true);
    const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
    socket.close();
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    socket.close(); // Repeated cleanup is safe.
    expect(() => socket.send("must not send after close")).toThrow();
  } finally { socket.close(); server.stop(true); }
}, 4000);

test("aborting an unopened DSH stream releases the socket worker", async () => {
  const { DeepSeekHarnessRemoteMux } = await import("../../src/bridge/deepseek-harness-remote.ts");
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch() { return new Response("not upgraded", { status: 401 }); },
  });
  try {
    const mux = new DeepSeekHarnessRemoteMux(`http://127.0.0.1:${server.port}`, () => null, 1000);
    const controller = new AbortController();
    const iterator = mux.open("test", {}, controller.signal)[Symbol.asyncIterator]();
    const next = iterator.next();
    controller.abort(new Error("cancelled by user"));
    await expect(next).rejects.toThrow("cancelled by user");
  } finally { server.stop(true); }
}, 4000);
