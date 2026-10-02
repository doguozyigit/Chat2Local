import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface DaemonStateLock { readonly path: string; release(): void }

// Closing another descriptor for an inode can release POSIX process locks.
// Refuse duplicate acquisitions in this process before opening another handle.
const heldPaths = new Set<string>();

/** A separate SQLite transaction holds the OS lock without blocking work-log writes. */
export function acquireDaemonStateLock(databasePath: string): DaemonStateLock {
  if (!databasePath.trim() || databasePath === ":memory:") throw new Error("Daemon state requires an on-disk database file.");
  const absolute = resolve(databasePath);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const parent = realpathSync(dirname(absolute));
  const directory = lstatSync(parent);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o022) !== 0) {
    throw new Error("Daemon state lock requires an owned folder that is not writable by others.");
  }
  const path = join(parent, `${basename(absolute)}.daemon-lock.sqlite`);
  if (heldPaths.has(path)) throw alreadyRunning();
  validateExistingPrivateFile(path);
  validateSidecars(path);
  let fd: number | undefined;
  let db: DatabaseSync | undefined;
  try {
    try { fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); }
    catch (error) { throw new Error("Daemon state lock must be an owned regular private file without symbolic links.", { cause: error }); }
    const identity = fstatSync(fd);
    assertPrivateFile(identity);
    assertSameFile(path, identity);
    db = new DatabaseSync(path, { timeout: 0 });
    assertSameFile(path, identity);
    db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE;");
    assertSameFile(path, identity);
    validateSidecars(path);
    heldPaths.add(path);
    const connection = db;
    const descriptor = fd;
    db = undefined;
    fd = undefined;
    let released = false;
    return {
      path,
      release() {
        if (released) return;
        released = true;
        try { connection.exec("ROLLBACK"); }
        finally {
          try { connection.close(); }
          finally { closeSync(descriptor); heldPaths.delete(path); }
        }
      },
    };
  } catch (error) {
    if ((error as { errcode?: number }).errcode === 5 || (error as { errcode?: number }).errcode === 6) throw alreadyRunning(error);
    throw error;
  } finally {
    try { db?.close(); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}

function alreadyRunning(cause?: unknown): Error {
  return new Error("Another Chat2Local daemon is already running with this state database.", { cause });
}
function assertPrivateFile(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.()) {
    throw new Error("Daemon state lock requires an owned regular file without symbolic links or hard links.");
  }
  if ((info.mode & 0o7777) !== 0o600) throw new Error("Daemon state lock has unsafe permissions; expected a private file with mode 0600.");
}
function validateExistingPrivateFile(path: string): void {
  try { assertPrivateFile(lstatSync(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function assertSameFile(path: string, identity: Stats): void {
  const current = lstatSync(path);
  assertPrivateFile(current);
  if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("Daemon state lock file changed while ownership was being acquired.");
}
function validateSidecars(path: string): void {
  for (const suffix of ["-journal", "-wal", "-shm"]) validateExistingPrivateFile(path + suffix);
}
