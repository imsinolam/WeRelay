import { execFile } from "node:child_process";

/** A failed process probe is unknown, not evidence that all desktop apps stopped. */
export async function readProcessSnapshot(
  probe: () => Promise<string> = () => new Promise((resolve, reject) => {
    execFile("ps", ["-axo", "command="], {
      encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
      timeout: 5_000, killSignal: "SIGKILL",
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  }),
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await probe(); } catch {
      if (attempt === 1) throw new Error("暂时无法确认运行中的终端，请稍后重试；未将本次读取视为空列表。");
    }
  }
  throw new Error("终端读取失败。");
}
