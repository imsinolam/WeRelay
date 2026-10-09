import { execFile } from "node:child_process";

/** A failed process probe is unknown, not evidence that all desktop apps stopped. */
export async function readProcessSnapshot(
  probe: () => Promise<string> = () => new Promise((resolve, reject) => {
    execFile("ps", ["-axo", "command="], {
      encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
      timeout: 2_500, killSignal: "SIGKILL",
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  }),
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await probe(); } catch (error) {
      if (attempt === 1) throw new Error(
        "暂时无法确认运行中的终端，请稍后重试；未将本次读取视为空列表。",
        { cause: error },
      );
    }
  }
  throw new Error("终端读取失败。");
}

/** A bounded fallback for an inconclusive process probe. Never classify an unknown scan as stopped. */
export function recoverOpenAdaptersAfterProbeFailure<T extends string>(options: {
  previous?: ReadonlySet<T>;
  lastSuccessAtMs?: number;
  nowMs: number;
  connected: Iterable<T>;
}): Set<T> {
  const open = new Set(options.connected);
  if (options.previous && options.lastSuccessAtMs &&
      options.nowMs - options.lastSuccessAtMs <= 120_000) {
    for (const adapter of options.previous) open.add(adapter);
  }
  if (open.size === 0) {
    throw new Error("暂时无法确认运行中的终端，请稍后重试；未将本次读取视为空列表。");
  }
  return open;
}
