import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatFolderError, ChatFolderStore } from "./chat-folder-store.js";
import { readScopedFile, writeScopedFile } from "./local-tools.js";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "local-dev-chat-folders-")));
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(first);
  mkdirSync(second);
  const databasePath = join(root, "state", "chat-folders.sqlite");
  const store = new ChatFolderStore(databasePath);
  return { root, first, second, databasePath, store,
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

const code = (expected: ChatFolderError["code"]) => (error: unknown) => error instanceof ChatFolderError && error.code === expected;

test("observed chats persist with opaque IDs and require an explicit folder selection", async () => {
  const f = fixture();
  try {
    const observed = f.store.observe("host-one", "First chat");
    assert.notEqual(observed.id, "host-one");
    assert.match(observed.setupCode, /^LD-[0-9A-F]{8}$/);
    assert.equal(observed.folderPath, null);
    assert.equal(observed.revision, 0);
    assert.equal("hostThreadId" in observed, false);
    await assert.rejects(f.store.useScope("host-one", () => assert.fail("unselected folder must not reach callback")), code("folder_required"));
    assert.equal(f.store.observe("host-one").title, "First chat");
    const connected = await f.store.connect(observed.id, f.first, 0);
    assert.equal(connected.revision, 1);
    f.store.close();
    const reopened = new ChatFolderStore(f.databasePath);
    try {
      assert.deepEqual(reopened.get(observed.id), connected);
      assert.equal(reopened.getByHost("host-one")?.setupCode, observed.setupCode);
      await reopened.useScope("host-one", (scope) => {
        assert.deepEqual(scope, { chatId: observed.id, hostThreadId: "host-one", projectPath: f.first, revision: 1 });
      });
      assert.equal(statSync(f.databasePath).mode & 0o777, 0o600);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test("folder storage exposes a durable recovery journal without changing folder grants", async () => {
  const f = fixture();
  try {
    assert.ok("workLog" in f.store, "folder storage must expose its shared recovery journal");
    const chat = f.store.observe("recovery-host");
    const connected = await f.store.connect(chat.id, f.first, 0);
    await f.store.useScope("recovery-host", (scope) => {
      assert.equal(typeof f.store.workLog.start(scope, "local_dev_write_file", { path: "saved.txt" }, true), "string");
    });
    assert.deepEqual(f.store.get(chat.id), connected);
    assert.equal(statSync(f.databasePath).mode & 0o777, 0o600);
  } finally { f.close(); }
});

test("multiple chats share a folder and can be reassigned or disconnected independently", async () => {
  const f = fixture();
  try {
    const first = f.store.observe("host-one");
    const second = f.store.observe("host-two");
    const one = await f.store.connect(first.id, f.first, 0);
    const two = await f.store.connect(second.id, f.first, 0);
    assert.equal(one.folderPath, two.folderPath);
    await f.store.useScope("host-one", (scope) => writeScopedFile(scope.projectPath, "shared.txt", "shared"));
    assert.equal(await f.store.useScope("host-two", async (scope) => (await readScopedFile(scope.projectPath, "shared.txt")).content), "shared");
    const moved = await f.store.connect(first.id, f.second, one.revision);
    assert.equal(moved.revision, 2);
    assert.equal(f.store.get(second.id)?.folderPath, f.first);
    f.store.disconnect(first.id, moved.revision);
    await assert.rejects(f.store.useScope("host-one", () => undefined), code("folder_required"));
    assert.equal(await f.store.useScope("host-two", (scope) => scope.projectPath), f.first);
    assert.equal(f.store.list().length, 2);
  } finally { f.close(); }
});

test("folder mutations reject stale revisions and simultaneous selections", async () => {
  const f = fixture();
  try {
    const chat = f.store.observe("host-one");
    const attempts = await Promise.allSettled([
      f.store.connect(chat.id, f.first, 0), f.store.connect(chat.id, f.second, 0),
    ]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((result) => result.status === "rejected" && code("revision_conflict")(result.reason)).length, 1);
    await assert.rejects(f.store.connect(chat.id, f.second, 0), code("revision_conflict"));
    assert.throws(() => f.store.disconnect(chat.id, 0), code("revision_conflict"));
    assert.equal(f.store.get(chat.id)?.revision, 1);
  } finally { f.close(); }
});

test("active tools hold their chat's folder until all scopes settle", async () => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  try {
    const chat = f.store.observe("host-one");
    await f.store.connect(chat.id, f.first, 0);
    const running = f.store.useScope("host-one", async () => { entered(); await gate; });
    await ready;
    assert.throws(() => f.store.disconnect(chat.id, 1), code("chat_busy"));
    await assert.rejects(f.store.connect(chat.id, f.second, 1), code("chat_busy"));
    await f.store.useScope("host-one", () => undefined);
    assert.throws(() => f.store.disconnect(chat.id, 1), code("chat_busy"));
    const other = f.store.observe("host-two");
    await f.store.connect(other.id, f.first, 0);
    f.store.disconnect(other.id, 1);
    release();
    await running;
    assert.equal(f.store.disconnect(chat.id, 1).folderPath, null);
    await f.store.connect(chat.id, f.second, 2);
    await assert.rejects(f.store.useScope("host-one", () => { throw new Error("tool failed"); }), /tool failed/);
    assert.equal(f.store.disconnect(chat.id, 3).folderPath, null);
  } finally { release(); f.close(); }
});

test("invalid or unavailable folders never reach local tools", async () => {
  const f = fixture();
  try {
    const chat = f.store.observe("host-one");
    const file = join(f.root, "file.txt");
    writeFileSync(file, "not a directory");
    for (const folder of ["", "relative/path", file, join(f.root, "missing")]) {
      await assert.rejects(f.store.connect(chat.id, folder, 0), code("invalid_project_folder"));
    }
    assert.equal(f.store.get(chat.id)?.folderPath, null);
    assert.equal(f.store.get(chat.id)?.revision, 0);
    const alias = join(f.root, "alias");
    symlinkSync(f.first, alias);
    assert.equal((await f.store.connect(chat.id, alias, 0)).folderPath, f.first);
    rmSync(f.first, { recursive: true });
    let called = false;
    await assert.rejects(f.store.useScope("host-one", () => { called = true; }), code("invalid_project_folder"));
    assert.equal(called, false);
    assert.equal(f.store.disconnect(chat.id, 1).folderPath, null);
  } finally { f.close(); }
});

test("chat identity and selected folders isolate local file access", async () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.observe(" "), code("missing_chat_identity"));
    await assert.rejects(f.store.useScope("", () => undefined), code("missing_chat_identity"));
    await assert.rejects(f.store.useScope("unknown-host", () => undefined), code("unknown_chat"));
    const first = f.store.observe("host-one");
    const second = f.store.observe("host-two");
    await f.store.connect(first.id, f.first, 0);
    await f.store.connect(second.id, f.second, 0);
    writeFileSync(join(f.first, "private.txt"), "first folder");
    symlinkSync(f.first, join(f.second, "escape"));
    await assert.rejects(f.store.useScope("host-two", (scope) => readScopedFile(scope.projectPath, join(f.first, "private.txt"))), /scope/i);
    await assert.rejects(f.store.useScope("host-two", (scope) => readScopedFile(scope.projectPath, "../first/private.txt")), /scope/i);
    await assert.rejects(f.store.useScope("host-two", (scope) => readScopedFile(scope.projectPath, "escape/private.txt")), /scope/i);
    assert.equal(await f.store.useScope("host-one", async (scope) => (await readScopedFile(scope.projectPath, "private.txt")).content), "first folder");
    f.store.close();
    assert.throws(() => f.store.list(), code("store_closed"));
  } finally { f.close(); }
});
