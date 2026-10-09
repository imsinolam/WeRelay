import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Exclusive per-user managed Pi owner, independent of the selected native session. */
export function acquirePiOwnerLock(root = path.join(os.homedir(), ".werelay", "runtime", "pi-owner")): () => void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
    (typeof process.getuid === "function" && rootStat.uid !== process.getuid())) {
    throw new Error("Pi owner 锁目录不安全，拒绝启动。");
  }
  if (process.platform !== "win32") fs.chmodSync(root, 0o700);
  const file = path.join(root, "owner.lock");
  const nonce = randomUUID();
  const contents = JSON.stringify({ pid: process.pid, nonce });
  const busy = new Error("已有 WeRelay 管理的 Pi 窗口，未启动第二个 owner。请在原窗口继续或关闭它后重试。");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, contents, { flag: "wx", mode: 0o600 });
      return () => {
        try {
          if (fs.readFileSync(file, "utf8") === contents) fs.unlinkSync(file);
        } catch { /* Already removed or replaced: never delete another owner's lock. */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let stat: fs.Stats;
    let record: { pid?: number };
    try {
      stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw busy;
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch { throw busy; }
    if (!Number.isSafeInteger(record.pid) || Number(record.pid) <= 0) throw busy;
    try { process.kill(record.pid!, 0); throw busy; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw busy; }
    // Reclaim only the exact stale inode observed above. Concurrent replacements fail closed.
    try {
      if (fs.lstatSync(file).ino !== stat.ino) throw busy;
      fs.unlinkSync(file);
    } catch { throw busy; }
  }
  throw busy;
}
