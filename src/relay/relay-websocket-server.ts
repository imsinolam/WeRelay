import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import {
  WERELAY_RELAY_SOCKET_MAX_PAYLOAD,
  WERELAY_RELAY_SOCKET_VERSION,
  WERELAY_RELAY_WEBSOCKET_PATH,
  WERELAY_RELAY_MAX_IN_FLIGHT,
  type WeRelayRelayCommand,
  type WeRelayRelayCommandResponse,
} from "./relay-protocol.ts";

/** Device-only channel, sharing the HTTP queue and response settlement. */
export function attachRelayWebSocketServer(options: {
  server: Server;
  authenticate: (request: IncomingMessage) => void;
  seen: () => void;
  cancelPoll: () => void;
  take: (exclude: Set<string>) => WeRelayRelayCommand | null;
  hasPending: (id: string) => boolean;
  complete: (value: unknown) => WeRelayRelayCommandResponse;
  heartbeatTimeoutMs: number;
}): { active: () => boolean; dispatch: () => void; close: () => void } {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: WERELAY_RELAY_SOCKET_MAX_PAYLOAD });
  let current: WebSocket | null = null;
  let credits = 0;
  let lastSeen = 0;
  const sent = new Set<string>();
  const write = (socket: WebSocket, type: string, fields: Record<string, unknown> = {}) => {
    if (socket.bufferedAmount > WERELAY_RELAY_SOCKET_MAX_PAYLOAD) {
      socket.terminate();
      return false;
    }
    socket.send(JSON.stringify({ version: WERELAY_RELAY_SOCKET_VERSION, type, ...fields }), (error) => {
      if (error) socket.terminate();
    });
    return true;
  };
  const dispatch = () => {
    if (!current || current.readyState !== WebSocket.OPEN) return;
    for (const id of sent) if (!options.hasPending(id)) sent.delete(id);
    while (credits > 0 && sent.size < WERELAY_RELAY_MAX_IN_FLIGHT) {
      const command = options.take(sent);
      if (!command) break;
      sent.add(command.id);
      credits -= 1;
      if (!write(current, "command", { command })) break;
    }
  };
  const upgrade = (request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const refuse = (code: number) => {
      socket.write(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
    };
    // No query-token auth, browser origin, alternate path or generic proxying.
    if (request.url !== WERELAY_RELAY_WEBSOCKET_PATH) { refuse(404); return; }
    if (request.headers.origin !== undefined) { refuse(403); return; }
    try { options.authenticate(request); } catch { refuse(401); return; }
    wss.handleUpgrade(request, socket, head, (connected) => {
      const previous = current;
      current = connected;
      credits = 0;
      sent.clear();
      previous?.terminate();
      options.cancelPoll();
      lastSeen = Date.now();
      options.seen();
      connected.on("error", () => connected.terminate());
      connected.on("close", () => {
        if (current === connected) { current = null; credits = 0; sent.clear(); }
      });
      connected.on("message", (data, binary) => {
        if (current !== connected) return;
        try {
          if (binary) throw new Error("binary frame");
          const message = JSON.parse(data.toString()) as Record<string, unknown>;
          if (!message || message.version !== WERELAY_RELAY_SOCKET_VERSION) throw new Error("version");
          if (message.type === "ready") {
            if (!Number.isInteger(message.capacity) || Number(message.capacity) < 0 || Number(message.capacity) > WERELAY_RELAY_MAX_IN_FLIGHT) throw new Error("capacity");
            credits = Math.min(Number(message.capacity), WERELAY_RELAY_MAX_IN_FLIGHT - sent.size);
          } else if (message.type === "response") {
            const response = options.complete(message.response);
            sent.delete(response.commandId);
            write(connected, "ack", { commandId: response.commandId });
          } else if (message.type === "heartbeat") {
            write(connected, "heartbeat-ack");
          } else throw new Error("frame");
          lastSeen = Date.now();
          options.seen();
          dispatch();
        } catch { connected.close(1008, "Invalid device protocol"); }
      });
      write(connected, "hello");
    });
  };
  options.server.on("upgrade", upgrade);
  // Revisit leases and detect half-open peers independently of business work.
  const timer = setInterval(() => {
    if (current && Date.now() - lastSeen > options.heartbeatTimeoutMs) current.terminate();
    dispatch();
  }, Math.max(10, Math.min(1_000, options.heartbeatTimeoutMs / 3)));
  timer.unref();
  return {
    active: () => current?.readyState === WebSocket.OPEN,
    dispatch,
    close: () => {
      clearInterval(timer);
      options.server.off("upgrade", upgrade);
      current?.terminate();
      current = null;
      wss.close();
    },
  };
}
