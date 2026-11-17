import os from "node:os";
import path from "node:path";
import { reviewTaskFailures } from "../src/daemon/task-failure-review.ts";

// Read-only; stdout deliberately contains no conversation text or raw error strings.
try {
  if (process.argv.length > 3) throw new Error("参数无效");
  const hours = process.argv[2] === undefined ? 24 : Number(process.argv[2]);
  const root = process.env.WERELAY_DATA_DIR || path.join(os.homedir(), ".werelay");
  console.log(JSON.stringify(reviewTaskFailures(root, { hours }), null, 2));
} catch {
  console.error("巡检失败：请检查时间参数（小时，1–2160）及本地记录读取权限。");
  process.exitCode = 1;
}
