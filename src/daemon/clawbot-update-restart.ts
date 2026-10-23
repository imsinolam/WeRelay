import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execFile);

/** Fail closed: a launchd label alone does not prove that exit will relaunch. */
export async function canRestartClawbotService(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  pid?: number;
  inspect?: (service: string) => Promise<string>;
} = {}): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  const label = (options.env ?? process.env).XPC_SERVICE_NAME ?? "";
  if (!/^com\.sinolin\.(?:werelay-daemon|codex-mobile-daemon)$/.test(label)) return false;
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) return false;
  try {
    const service = `gui/${uid}/${label}`;
    const output = await (options.inspect ?? (async (name) => {
      const { stdout } = await execAsync("/bin/launchctl", ["print", name], { timeout: 5_000, maxBuffer: 1024 * 1024 });
      return stdout;
    }))(service);
    // Require both unconditional keepalive and our own PID. Do not exit based
    // on an arbitrary service name or a stale plist that may not be loaded.
    const pid = Number(/^\s*pid\s*=\s*(\d+)\s*$/m.exec(output)?.[1]);
    const properties = /^\s*properties\s*=\s*(.*)$/m.exec(output)?.[1] ?? "";
    return pid === (options.pid ?? process.pid) && properties.split(/\s*\|\s*/).includes("keepalive");
  } catch { return false; }
}
