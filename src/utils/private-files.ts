import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_EXECUTABLE_MODE = 0o700;

function isPosix(): boolean {
  return process.platform !== "win32";
}

function chmodPrivate(filePath: string, mode: number): void {
  if (!isPosix()) {
    return;
  }
  fs.chmodSync(filePath, mode);
}

export function ensurePrivateDir(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodPrivate(directory, PRIVATE_DIR_MODE);
}

export function ensurePrivateFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) {
    return;
  }
  chmodPrivate(filePath, PRIVATE_FILE_MODE);
}

export function writePrivateFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: { encoding?: BufferEncoding } = {},
): void {
  ensurePrivateDir(path.dirname(filePath));
  const temporaryFile = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryFile, data, {
      ...options,
      mode: PRIVATE_FILE_MODE,
    });
    chmodPrivate(temporaryFile, PRIVATE_FILE_MODE);
    fs.renameSync(temporaryFile, filePath);
    chmodPrivate(filePath, PRIVATE_FILE_MODE);
  } finally {
    fs.rmSync(temporaryFile, { force: true });
  }
}

export function appendPrivateFile(
  filePath: string,
  data: string | Uint8Array,
  options: { encoding?: BufferEncoding } = {},
): void {
  ensurePrivateDir(path.dirname(filePath));
  fs.appendFileSync(filePath, data, {
    ...options,
    mode: PRIVATE_FILE_MODE,
  });
  ensurePrivateFile(filePath);
}

export function repairPrivateTreePermissions(root: string): void {
  if (!fs.existsSync(root)) {
    return;
  }
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) {
    return;
  }
  if (stat.isDirectory()) {
    // 只在权限确实不符时才调用 chmod：运行时目录会随附件和历史增长到上万个
    // 文件，无条件逐个 chmod 会让每次启动都长时间不可用。这里比较完整的
    // 权限位（含 setuid/setgid/sticky），确保特殊位仍会被清理。
    if ((stat.mode & 0o7777) !== PRIVATE_DIR_MODE) {
      chmodPrivate(root, PRIVATE_DIR_MODE);
    }
    for (const entry of fs.readdirSync(root)) {
      repairPrivateTreePermissions(path.join(root, entry));
    }
    return;
  }
  if (stat.isFile()) {
    const expectedMode = (stat.mode & 0o111) !== 0
      ? PRIVATE_EXECUTABLE_MODE
      : PRIVATE_FILE_MODE;
    if ((stat.mode & 0o7777) !== expectedMode) {
      chmodPrivate(root, expectedMode);
    }
  }
}
