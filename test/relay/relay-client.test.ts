import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  startWeRelayRelayClient,
  WeRelayRelayCommandJournal,
} from "../../src/relay/relay-client.ts";
import {
  WERELAY_RELAY_POLL_PATH,
  WERELAY_RELAY_PROTOCOL_VERSION,
  WERELAY_RELAY_RESPONSE_PATH,
  type WeRelayRelayCommand,
  type WeRelayRelayCommandResponse,
} from "../../src/relay/relay-protocol.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("WeRelay relay command journal", () => {
  test("persists completed non-idempotent command responses across restarts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-relay-journal-"));
    tempDirs.push(directory);
    const stateFile = path.join(directory, "journal.json");
    const response: WeRelayRelayCommandResponse = {
      protocolVersion: WERELAY_RELAY_PROTOCOL_VERSION,
      commandId: "relay-command-1",
      statusCode: 200,
      headers: { "content-type": "application/json" },
      bodyBase64: Buffer.from('{"ok":true}').toString("base64"),
    };

    new WeRelayRelayCommandJournal(stateFile).save(response);

    expect(new WeRelayRelayCommandJournal(stateFile).get("relay-command-1"))
      .toEqual(response);
    if (process.platform !== "win32") {
      expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    }
  });

  test("does not let a slow read block a later task creation command", async () => {
    let releaseSlowRead: (() => void) | null = null;
    const slowRead = new Promise<void>((resolve) => { releaseSlowRead = resolve; });
    const postedResponses: string[] = [];
    let pollCount = 0;
    const command = (
      id: string,
      method: WeRelayRelayCommand["request"]["method"],
      requestPath: string,
    ): WeRelayRelayCommand => ({
      protocolVersion: WERELAY_RELAY_PROTOCOL_VERSION,
      id,
      deviceId: "device-1",
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 30_000,
      request: {
        method,
        path: requestPath,
        headers: {},
        clientAddress: "127.0.0.1",
        forwardedProto: "https",
      },
    });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(WERELAY_RELAY_POLL_PATH)) {
        pollCount += 1;
        if (pollCount === 1) {
          return Response.json(command("slow-read", "GET", "/api/tasks"));
        }
        if (pollCount === 2) {
          return Response.json(command("create-task", "POST", "/api/tasks"));
        }
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      if (url === "http://127.0.0.1:4396/api/tasks" && init?.method === "GET") {
        await slowRead;
        return Response.json({ tasks: [] });
      }
      if (url === "http://127.0.0.1:4396/api/tasks" && init?.method === "POST") {
        return Response.json({ task: { threadId: "created-task" } }, { status: 201 });
      }
      if (url.endsWith(WERELAY_RELAY_RESPONSE_PATH)) {
        const response = JSON.parse(String(init?.body)) as WeRelayRelayCommandResponse;
        postedResponses.push(response.commandId);
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const handle = startWeRelayRelayClient({
      relayUrl: "https://relay.example",
      deviceId: "device-1",
      deviceToken: "token-1",
      localBaseUrl: "http://127.0.0.1:4396",
      fetchImpl,
      retryDelayMs: 1,
    });

    const creationPostedBeforeReadFinished = await Promise.race([
      (async () => {
        while (!postedResponses.includes("create-task")) await Bun.sleep(5);
        return true;
      })(),
      Bun.sleep(100).then(() => false),
    ]);
    releaseSlowRead?.();
    await handle.close();

    expect(creationPostedBeforeReadFinished).toBe(true);
  });
});
