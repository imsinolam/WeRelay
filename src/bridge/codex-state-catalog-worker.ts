import { parentPort } from "node:worker_threads";

import {
  readCodexStateDbSessionCatalogInProcess,
  type CodexStateDbSessionCatalogOptions,
} from "./bridge-adapters.codex.ts";

type Request = {
  id: number;
  options: CodexStateDbSessionCatalogOptions;
};

if (!parentPort) {
  throw new Error("Codex state catalog worker requires a parent port.");
}
const port = parentPort;

port.on("message", async (request: Request) => {
  try {
    const catalog = await readCodexStateDbSessionCatalogInProcess(request.options);
    port.postMessage({ id: request.id, ok: true, catalog });
  } catch (error) {
    port.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
