import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** Persist a local-only bearer secret without putting it in daemon process.env. */
export function loadOrCreateApiToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(dataDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()
    || directory.uid !== process.getuid?.()
    || (directory.mode & 0o022) !== 0) {
    throw new Error("Chat2Local data directory must be owned by this user and not writable by others.");
  }

  const tokenPath = join(dataDir, "api-token");
  const candidate = randomBytes(32).toString("hex");
  const temporaryPath = join(dataDir, `.api-token-${randomBytes(16).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    writeSync(fd, `${candidate}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temporaryPath, tokenPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporaryPath); } catch { /* May not have been created. */ }
  }

  const tokenFd = openSync(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(tokenFd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) {
      throw new Error("Chat2Local API token must be an owned regular file, not a symbolic link.");
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error("Chat2Local API token has unsafe permissions; expected owner-only access.");
    }
    const token = readFileSync(tokenFd, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(token)) {
      throw new Error("Chat2Local API token file has invalid contents.");
    }
    return token;
  } finally {
    closeSync(tokenFd);
  }
}
