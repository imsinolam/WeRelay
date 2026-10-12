import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type PiOwnerAdvertisement = {
  pid: number;
  cwd: string;
  sessionId: string;
  socket: string;
  token: string;
  status?: "idle" | "busy";
};

export function piOwnerDirectory(): string {
  return process.env.WERELAY_PI_OWNER_DIRECTORY || path.join(os.homedir(), ".werelay", "runtime", "pi-owners");
}

/** Only trust live, same-user owner records in a private directory. */
export function discoverPiOwners(directory = piOwnerDirectory()): PiOwnerAdvertisement[] {
  let root: fs.Stats;
  try { root = fs.lstatSync(directory); } catch { return []; }
  if (!root.isDirectory() || root.isSymbolicLink() ||
    (process.getuid && root.uid !== process.getuid()) || (root.mode & 0o077)) return [];
  const owners: PiOwnerAdvertisement[] = [];
  for (const name of fs.readdirSync(directory)) {
    const identity = /^(\d+)(?:-[0-9a-f]{16})?\.json$/.exec(name);
    if (!identity) continue;
    const file = path.join(directory, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
        (process.getuid && stat.uid !== process.getuid()) || stat.size > 4096) continue;
      const record = JSON.parse(fs.readFileSync(file, "utf8")) as PiOwnerAdvertisement;
      if (record.pid !== Number(identity[1]) || !Number.isSafeInteger(record.pid) ||
        !path.isAbsolute(record.cwd) || !/^[0-9a-f-]{36}$/i.test(record.sessionId) ||
        typeof record.token !== "string" || !/^[0-9a-f]{64}$/.test(record.token) ||
        typeof record.socket !== "string" || !path.isAbsolute(record.socket)) continue;
      process.kill(record.pid, 0);
      const socket = fs.lstatSync(record.socket);
      if (!socket.isSocket() || socket.isSymbolicLink() || (socket.mode & 0o077) ||
        (process.getuid && socket.uid !== process.getuid())) continue;
      owners.push({
        pid: record.pid, cwd: record.cwd, sessionId: record.sessionId, socket: record.socket, token: record.token,
        ...(record.status === "idle" || record.status === "busy" ? { status: record.status } : {}),
      });
    } catch { /* stale or malformed owner: never attach */ }
  }
  return owners;
}

export function selectPiOwner(owners: PiOwnerAdvertisement[], sessionId: string | undefined, cwd: string): PiOwnerAdvertisement | undefined {
  const matches = sessionId ? owners.filter((owner) => owner.sessionId === sessionId)
    : owners.filter((owner) => path.resolve(owner.cwd) === path.resolve(cwd));
  // Ambiguous ownership is unsafe; no arbitrary first match.
  return matches.length === 1 ? matches[0] : undefined;
}
