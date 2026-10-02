import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const lockModule = new URL("./daemon-lock.ts", import.meta.url).href;
const storeModule = new URL("./chat-folder-store.ts", import.meta.url).href;
interface Lock { path: string; release(): void }
async function acquireFunction(): Promise<(databasePath: string) => Lock> {
  const module = await import(lockModule).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    return { acquireDaemonStateLock: (databasePath: string) => ({ path: `${databasePath}.daemon-lock.sqlite`, release() {} }) };
  });
  return module.acquireDaemonStateLock;
}
function fixture() {
  const base = join(process.cwd(), ".tmp-tests");
  mkdirSync(base, { recursive: true });
  const root = realpathSync(mkdtempSync(join(base, "daemon-state-lock-")));
  const databasePath = join(root, "chat-folders.sqlite");
  return { root, databasePath, lockPath: `${databasePath}.daemon-lock.sqlite`, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
function message(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("child did not report its state")); }, 5_000);
    const receive = (value: unknown) => { cleanup(); resolve(value as Record<string, unknown>); };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => { cleanup(); reject(new Error(`child exited before reporting: ${code}/${signal}`)); };
    const cleanup = () => { clearTimeout(timer); child.off("message", receive); child.off("exit", exited); child.off("error", reject); };
    child.once("message", receive);
    child.once("exit", exited);
    child.once("error", reject);
  });
}
function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
function childWithState(databasePath: string, boot: string, owner: boolean): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { ChatFolderStore } from ${JSON.stringify(storeModule)};
    const { acquireDaemonStateLock } = await import(${JSON.stringify(lockModule)}).catch((error) => {
      if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
      return { acquireDaemonStateLock: () => ({ release() {} }) };
    });
    try {
      const lock = acquireDaemonStateLock(${JSON.stringify(databasePath)});
      const chats = new ChatFolderStore(${JSON.stringify(databasePath)}, { bootId: ${JSON.stringify(boot)} });
      if (${owner}) {
        const chat = chats.observe("lock-fixture-host");
        const id = chats.workLog.start({ chatId: chat.id, revision: chat.revision }, "local_dev_file_write", { path: "fixture.txt" }, true);
        const hold = setInterval(() => {}, 1000);
        process.send({ phase: "owned", id });
        process.on("message", (command) => {
          if (command === "finish") {
            try { chats.workLog.finish(id, "execution_recorded", {}); process.send({ phase: "finished" }); }
            catch (error) { process.send({ phase: "finish-failed", message: error.message }); }
          }
          if (command === "close") {
            try { chats.close(); } finally { lock.release(); clearInterval(hold); }
            process.send({ phase: "closed" }, () => process.exit(0));
          }
        });
      } else {
        chats.close(); lock.release(); process.send({ phase: "acquired" }, () => process.exit(0));
      }
    } catch (error) {
      process.send({ phase: "refused", message: error.message }, () => process.exit(0));
    }
  `], { cwd: process.cwd(), stdio: ["ignore", "ignore", "ignore", "ipc"] });
}
function eventStatus(databasePath: string, id: unknown): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try { return (database.prepare("SELECT status FROM work_log_events WHERE id=?").get(String(id)) as { status: string }).status; }
  finally { database.close(); }
}
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
function startup(child: ChildProcess): Promise<{ phase: "listening" | "exited"; code?: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => { cleanup(); reject(new Error(`daemon did not settle startup: ${stderr}`)); }, 5_000);
    const data = (chunk: Buffer) => {
      stderr += String(chunk);
      if (stderr.includes(" listening on ")) { cleanup(); resolve({ phase: "listening", stderr }); }
    };
    const exit = (code: number | null) => { cleanup(); resolve({ phase: "exited", code, stderr }); };
    const cleanup = () => { clearTimeout(timer); child.stderr!.off("data", data); child.off("exit", exit); child.off("error", reject); };
    child.stderr!.on("data", data); child.once("exit", exit); child.once("error", reject);
  });
}

test("daemon lock is private, held until release, and retained as a stable file", async () => {
  const f = fixture();
  const acquire = await acquireFunction();
  let lock: Lock | undefined;
  try {
    lock = acquire(f.databasePath);
    assert.equal(existsSync(f.lockPath), true, "ownership needs a real OS-locked file");
    const before = statSync(f.lockPath);
    assert.equal(before.mode & 0o7777, 0o600);
    assert.equal(before.nlink, 1);
    assert.throws(() => acquire(f.databasePath), /already.*running|state.*in use|locked/i);
    lock.release(); lock.release(); lock = undefined;
    const next = acquire(f.databasePath);
    try { assert.equal(statSync(f.lockPath).ino, before.ino, "release must never unlink the shared lock file"); }
    finally { next.release(); }
  } finally { lock?.release(); f.dispose(); }
});

test("a second process cannot reclassify a live owner's started operation", async () => {
  const f = fixture();
  const owner = childWithState(f.databasePath, "first-owner", true);
  let competitor: ChildProcess | undefined;
  try {
    const owned = await message(owner);
    assert.equal(owned.phase, "owned");
    competitor = childWithState(f.databasePath, "second-owner", false);
    const attempt = await message(competitor);
    await exited(competitor);
    assert.equal(attempt.phase, "refused", "another process must fail before constructing recovery storage");
    assert.equal(eventStatus(f.databasePath, owned.id), "started");
    const finished = message(owner); owner.send("finish");
    assert.equal((await finished).phase, "finished", "the original owner must still be able to finish its operation");
    assert.equal(eventStatus(f.databasePath, owned.id), "execution_recorded");
    const closed = message(owner); owner.send("close"); await closed; await exited(owner);
    const next = childWithState(f.databasePath, "next-owner", false);
    try { assert.equal((await message(next)).phase, "acquired"); await exited(next); }
    finally { next.kill("SIGKILL"); }
  } finally { owner.kill("SIGKILL"); competitor?.kill("SIGKILL"); await exited(owner); if (competitor) await exited(competitor); f.dispose(); }
});

test("SIGKILL releases ownership so the next process can classify interrupted work", async () => {
  const f = fixture();
  const owner = childWithState(f.databasePath, "killed-owner", true);
  let next: ChildProcess | undefined;
  try {
    const owned = await message(owner);
    assert.equal(owned.phase, "owned");
    assert.equal(owner.kill("SIGKILL"), true);
    await exited(owner);
    next = childWithState(f.databasePath, "replacement-owner", false);
    assert.equal((await message(next)).phase, "acquired");
    await exited(next);
    assert.equal(eventStatus(f.databasePath, owned.id), "outcome_unknown");
  } finally { owner.kill("SIGKILL"); next?.kill("SIGKILL"); await exited(owner); if (next) await exited(next); f.dispose(); }
});

test("daemon entry point refuses shared state before constructing recovery storage on another port", async () => {
  const f = fixture();
  const owner = childWithState(f.databasePath, "entry-point-owner", true);
  let competingDaemon: ChildProcess | undefined;
  try {
    const owned = await message(owner);
    assert.equal(owned.phase, "owned");
    const port = await unusedPort();
    competingDaemon = spawn(process.execPath, ["--import", "tsx", new URL("./index.ts", import.meta.url).pathname], {
      cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, LOCAL_DEV_DATA_DIR: f.root, LOCAL_DEV_CHAT_FOLDERS_DATABASE: f.databasePath, LOCAL_DEV_PORT: String(port), LOCAL_DEV_PARENT_PID: "", LOCAL_DEV_TUNNEL_CLIENT: "" },
    });
    const result = await startup(competingDaemon);
    assert.equal(result.phase, "exited", "shared state must be refused even when another port is available");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /already running.*state database/i);
    assert.equal(eventStatus(f.databasePath, owned.id), "started");
    const finished = message(owner); owner.send("finish"); assert.equal((await finished).phase, "finished");
  } finally {
    owner.kill("SIGKILL"); competingDaemon?.kill("SIGKILL"); await exited(owner); if (competingDaemon) await exited(competingDaemon); f.dispose();
  }
});

for (const kind of ["symlink", "hardlink", "permissions", "directory", "journal-symlink"] as const) {
  test(`daemon lock refuses an unsafe ${kind}`, async () => {
    const f = fixture();
    const acquire = await acquireFunction();
    const outside = join(f.root, "unrelated.txt");
    writeFileSync(outside, "must remain unchanged\n", { mode: 0o600 });
    try {
      if (kind === "symlink") symlinkSync(outside, f.lockPath);
      if (kind === "hardlink") linkSync(outside, f.lockPath);
      if (kind === "permissions") { writeFileSync(f.lockPath, ""); chmodSync(f.lockPath, 0o644); }
      if (kind === "directory") mkdirSync(f.lockPath);
      if (kind === "journal-symlink") symlinkSync(outside, `${f.lockPath}-journal`);
      assert.throws(() => { const lock = acquire(f.databasePath); lock.release(); }, /owned|regular|private|permission|symbolic|unsafe/i);
      assert.equal(readFileSync(outside, "utf8"), "must remain unchanged\n");
    } finally { f.dispose(); }
  });
}

test("daemon lock rejects an in-memory state path", async () => {
  const acquire = await acquireFunction();
  assert.throws(() => acquire(":memory:"), /on.disk|file|persist/i);
});
