import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkLogError, WorkLogStore, type WorkLogStoreOptions } from "./work-log-store.js";

const scope = { chatId: "chat-one", revision: 1, projectPath: "/private/project-one" };
const checkpoint = { goal: "Repair the save flow", completed: ["Inspected code"], verification: ["Existing checks pass"], nextStep: "Implement save", status: "in_progress" as const };
const code = (expected: WorkLogError["code"]) => (error: unknown) => error instanceof WorkLogError && error.code === expected;

function fixture(options: WorkLogStoreOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "local-dev-work-log-"));
  const path = join(root, "state.sqlite");
  const db = new DatabaseSync(path);
  const log = new WorkLogStore(db, "boot-one", options);
  return { root, path, db, log, close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("journal persists checkpoint and local execution with increasing scoped sequences", () => {
  const f = fixture();
  try {
    const saved = f.log.checkpoint(scope, checkpoint);
    const id = f.log.start(scope, "local_dev_write_file", { path: "saved.txt", bytes: 25 }, true);
    assert.equal(f.log.summary(scope).activeOperations, 1);
    f.log.finish(id, "execution_recorded", { category: "success", bytes: 25 });
    const page = f.log.read(scope);
    assert.equal(page.events[0]?.id, id);
    assert.equal(page.events[0]?.sequence, saved.sequence + 1);
    assert.equal(page.events[0]?.status, "execution_recorded");
    assert.equal(page.events[0]?.mayHaveSideEffects, true);
    assert.equal(page.summary.latestSequence, saved.sequence + 1);
    assert.equal(page.summary.reviewRequired, false);
    assert.equal(page.folderPath, scope.projectPath);
    assert.ok(page.events[0]?.endedAt);
    const reopened = new WorkLogStore(f.db, "boot-two");
    assert.deepEqual(reopened.read(scope), page);
    assert.equal(reopened.start(scope, "local_dev_read_file", { path: "saved.txt" }, false).length, 36);
    assert.equal(reopened.summary(scope).latestSequence, saved.sequence + 2);
  } finally { f.close(); }
});

test("restart classifies prior-run starts as unknown and preserves active current-run operations", () => {
  const f = fixture();
  try {
    const write = f.log.start(scope, "local_dev_write_file", { path: "saved.txt" }, true);
    const inspect = f.log.start(scope, "local_dev_read_file", { path: "saved.txt" }, false);
    const resumed = new WorkLogStore(f.db, "boot-two");
    const page = resumed.read(scope);
    assert.deepEqual(page.events.map((event) => event.status), ["outcome_unknown", "outcome_unknown"]);
    assert.equal(page.summary.activeOperations, 0);
    assert.equal(page.summary.unresolvedOperations, 2);
    assert.equal(page.summary.reviewRequired, true);
    assert.throws(() => resumed.finish(write, "execution_recorded", { category: "success" }), code("operation_finished"));
    resumed.review(scope, [write], "Inspected saved.txt; replacement is complete.");
    assert.equal(resumed.summary(scope).reviewRequired, false);
    assert.equal(resumed.summary(scope).unresolvedOperations, 1);
    assert.equal(resumed.read(scope).events.find((event) => event.id === write)?.status, "outcome_unknown");
    const active = resumed.start(scope, "local_dev_run", { kind: "shell" }, true);
    new WorkLogStore(f.db, "boot-two");
    assert.equal(resumed.read(scope).events.find((event) => event.id === active)?.status, "started");
    assert.equal(resumed.read(scope).events.find((event) => event.id === inspect)?.reviewedAt, null);
  } finally { f.close(); }
});

test("chat and folder revision isolate pagination, review, and archived revision labels", () => {
  const f = fixture();
  try {
    const ids = Array.from({ length: 4 }, (_, i) => f.log.start(scope, "local_dev_read_file", { path: `${i}.txt` }, false));
    ids.forEach((id) => f.log.finish(id, "execution_recorded", { category: "success" }));
    const other = { ...scope, chatId: "chat-two" };
    const moved = { ...scope, revision: 2, projectPath: "/private/project-two" };
    const otherId = f.log.start(other, "local_dev_run", {}, true);
    f.log.finish(otherId, "execution_error", { category: "timeout" });
    f.log.checkpoint(moved, checkpoint);
    assert.equal(f.log.read(moved).events.length, 0);
    assert.equal(f.log.summary(moved).latestSequence, 1);
    const first = f.log.read(scope, { limit: 2 });
    assert.deepEqual(first.events.map((event) => event.sequence), [4, 3]);
    assert.equal(first.nextBeforeSequence, 3);
    const second = f.log.read(scope, { limit: 2, beforeSequence: first.nextBeforeSequence! });
    assert.deepEqual(second.events.map((event) => event.sequence), [2, 1]);
    assert.equal(second.nextBeforeSequence, null);
    assert.throws(() => f.log.review(scope, [otherId], "Reviewed"), code("operation_not_found"));
    assert.equal(f.log.summary(other).reviewRequired, true);
    assert.deepEqual(f.log.revisions(scope.chatId).map(({ revision, folderPath }) => ({ revision, folderPath })), [
      { revision: 2, folderPath: moved.projectPath }, { revision: 1, folderPath: scope.projectPath },
    ]);
    assert.equal(f.log.clearCompleted(scope), 4);
    assert.equal(f.log.read(other).events.length, 1);
    assert.equal(f.log.read(moved).checkpoint?.goal, checkpoint.goal);
  } finally { f.close(); }
});

test("uncertain side-effect errors require review and survive clearing completed history", () => {
  const f = fixture();
  try {
    const completed = f.log.start(scope, "local_dev_write_file", {}, true);
    f.log.finish(completed, "execution_recorded", { category: "success" });
    const failed = f.log.start(scope, "local_dev_run", {}, true);
    f.log.finish(failed, "execution_error", { category: "nonzero_exit", exitCode: 1 });
    const inspect = f.log.start(scope, "local_dev_read_file", {}, false);
    f.log.finish(inspect, "execution_error", { category: "not_found" });
    const pending = f.log.start(scope, "local_dev_write_file", {}, true);
    const saved = f.log.checkpoint(scope, checkpoint);
    assert.equal(f.log.clearCompleted(scope), 1);
    assert.equal(f.log.summary(scope).reviewRequired, true);
    assert.equal(f.log.read(scope).events.length, 3);
    assert.throws(() => f.log.review(scope, [pending], "Not yet settled"), code("invalid_input"));
    f.log.review(scope, [failed, inspect], "Checked files and process status.");
    assert.equal(f.log.summary(scope).reviewRequired, false);
    assert.equal(f.log.clearCompleted(scope), 2);
    assert.equal(f.log.read(scope).events[0]?.id, pending);
    assert.deepEqual(f.log.read(scope).checkpoint, saved);
  } finally { f.close(); }
});

test("close records unknown pending execution without closing its owner's connection", () => {
  const f = fixture();
  try {
    f.log.start(scope, "local_dev_run", {}, true);
    f.log.closeRun();
    assert.equal(f.db.prepare("SELECT 1 AS open").get()?.open, 1);
    const resumed = new WorkLogStore(f.db, "boot-two");
    assert.equal(resumed.read(scope).events[0]?.status, "outcome_unknown");
    assert.equal(resumed.summary(scope).reviewRequired, true);
    assert.throws(() => f.log.start(scope, "local_dev_run", {}, true), code("store_closed"));
  } finally { f.close(); }
});

test("retention prunes old or excess recorded completion and keeps checkpoints and unreviewed errors", () => {
  let now = new Date("2026-08-01T00:00:00.000Z");
  const f = fixture({ now: () => now, maxEventsPerScope: 2 });
  try {
    const saved = f.log.checkpoint(scope, checkpoint);
    const failure = f.log.start(scope, "local_dev_run", {}, true);
    f.log.finish(failure, "execution_error", { category: "timeout" });
    for (let i = 0; i < 4; i++) {
      const id = f.log.start(scope, "local_dev_read_file", { path: `${i}.txt` }, false);
      f.log.finish(id, "execution_recorded", { category: "success" });
    }
    assert.equal(f.log.read(scope).events.filter((event) => event.status === "execution_recorded").length, 2);
    now = new Date("2026-09-02T00:00:00.000Z");
    f.log.start(scope, "local_dev_read_file", {}, false);
    assert.equal(f.log.read(scope).events.some((event) => event.status === "execution_recorded"), false);
    assert.equal(f.log.read(scope).events.some((event) => event.id === failure), true);
    assert.deepEqual(f.log.read(scope).checkpoint, saved);
  } finally { f.close(); }
});

test("global budget refuses starts when protected recovery evidence cannot be safely pruned", () => {
  const f = fixture({ maxRows: 5 });
  try {
    f.log.checkpoint(scope, checkpoint);
    f.log.start(scope, "local_dev_run", {}, true);
    f.log.start(scope, "local_dev_run", {}, true);
    assert.throws(() => f.log.start(scope, "local_dev_run", {}, true), code("storage_full"));
    assert.equal(f.log.read(scope).events.length, 2);
    assert.equal(f.log.read(scope).checkpoint?.goal, checkpoint.goal);
  } finally { f.close(); }
});

test("global byte budget prunes safe completion and refuses to discard protected evidence", () => {
  const f = fixture({ maxBytes: 6000 });
  try {
    f.log.checkpoint(scope, checkpoint);
    for (let i = 0; i < 15; i++) {
      const id = f.log.start(scope, "local_dev_read_file", { path: "p".repeat(450) }, false);
      f.log.finish(id, "execution_recorded", { category: "success" });
    }
    assert.ok(f.log.read(scope).events.length < 15);
    let count = 0;
    assert.throws(() => { while (count++ < 30) f.log.start(scope, "local_dev_run", { path: "p".repeat(450) }, true); }, code("storage_full"));
    assert.equal(f.log.read(scope).checkpoint?.goal, checkpoint.goal);
    assert.ok(f.log.summary(scope).activeOperations > 0);
  } finally { f.close(); }
});

test("metadata is primitive and bounded; checkpoint validates before saving and redacts secrets", () => {
  const f = fixture();
  try {
    assert.throws(() => f.log.start(scope, "local_dev_run", { raw: { password: "secret" } } as never, true), code("invalid_input"));
    assert.throws(() => f.log.start(scope, "local_dev_run", { large: "x".repeat(513) }, true), code("invalid_input"));
    assert.throws(() => f.log.start(scope, "local_dev_run", { number: Infinity }, true), code("invalid_input"));
    assert.throws(() => f.log.checkpoint(scope, { ...checkpoint, goal: "x".repeat(8193) }), code("invalid_input"));
    assert.throws(() => f.log.checkpoint(scope, { ...checkpoint, completed: Array.from({ length: 101 }, () => "step") }), code("invalid_input"));
    assert.throws(() => f.log.checkpoint(scope, { ...checkpoint, status: "made_up" } as never), code("invalid_input"));
    assert.equal(f.log.summary(scope).latestSequence, 0);
    const secret = "ghp_" + "abcdefghijklmnopqrstuvwxyz1234567890";
    const saved = f.log.checkpoint(scope, { ...checkpoint, goal: `Token ${secret}`, nextStep: "Check https://user:pass@example.com/path?token=abc#key" });
    assert.equal(JSON.stringify(saved).includes(secret), false);
    assert.equal(saved.nextStep.includes("user:pass"), false);
    assert.equal(saved.nextStep.includes("token=abc"), false);
    assert.equal(saved.nextStep.includes("#key"), false);
    const id = f.log.start(scope, "local_dev_read_file", { path: "saved.txt", label: `password=${secret}` }, false);
    assert.equal(JSON.stringify(f.log.read(scope)).includes(secret), false);
    assert.throws(() => f.log.finish(id, "execution_recorded", { value: "x".repeat(513) }), code("invalid_input"));
    assert.equal(f.log.read(scope).events[0]?.status, "started");
  } finally { f.close(); }
});

test("write faults leave pre-execution failure empty and post-execution failure durably started", () => {
  let fail: "start" | "finish" | null = "start";
  const f = fixture({ beforeWrite: (phase) => { if (phase === fail) throw new Error(`injected ${phase} failure`); } });
  try {
    assert.throws(() => f.log.start(scope, "local_dev_write_file", {}, true), /injected start failure/);
    assert.equal(f.log.read(scope).events.length, 0);
    fail = null;
    const id = f.log.start(scope, "local_dev_write_file", {}, true);
    fail = "finish";
    assert.throws(() => f.log.finish(id, "execution_recorded", { category: "success" }), /injected finish failure/);
    assert.equal(f.log.read(scope).events[0]?.status, "started");
    fail = null;
    assert.equal(new WorkLogStore(f.db, "boot-two").read(scope).events[0]?.status, "outcome_unknown");
  } finally { f.close(); }
});

test("invalid identifiers and paging do not leak or create records", () => {
  const f = fixture();
  try {
    for (const invalid of [{ ...scope, chatId: "" }, { ...scope, revision: -1 }, { ...scope, revision: 1.5 }]) {
      assert.throws(() => f.log.read(invalid), code("invalid_input"));
    }
    assert.throws(() => f.log.read(scope, { limit: 201 }), code("invalid_input"));
    assert.throws(() => f.log.read(scope, { beforeSequence: 0 }), code("invalid_input"));
    assert.throws(() => f.log.start(scope, "bad tool", {}, false), code("invalid_input"));
    assert.equal(f.log.summary(scope).latestSequence, 0);
  } finally { f.close(); }
});

test("same-run completion write failures can be classified and reviewed without claiming execution success", () => {
  let fail = false;
  const f = fixture({ beforeWrite: (phase) => { if (phase === "finish" && fail) throw new Error("storage unavailable"); } });
  try {
    const id = f.log.start(scope, "local_dev_write_file", {}, true);
    fail = true;
    assert.throws(() => f.log.finish(id, "execution_recorded", { category: "success" }), /storage unavailable/);
    assert.throws(() => f.log.markOutcomeUnknown(id), /storage unavailable/);
    assert.equal(f.log.read(scope).events[0]?.status, "outcome_unknown");
    assert.equal(f.log.summary(scope).activeOperations, 0);
    assert.equal(f.log.summary(scope).unresolvedOperations, 1);
    assert.equal(f.log.summary(scope).reviewRequired, true);
    fail = false;
    f.log.review(scope, [id], "Inspected the replacement on disk.");
    assert.equal(f.log.read(scope).events[0]?.status, "outcome_unknown");
    assert.equal(f.log.summary(scope).reviewRequired, false);
    assert.ok(f.log.read(scope).events[0]?.reviewedAt);
    const reopened = new WorkLogStore(f.db, "boot-two");
    assert.equal(reopened.read(scope).events[0]?.status, "outcome_unknown");
    assert.equal(reopened.summary(scope).reviewRequired, false);
  } finally { f.close(); }
});

test("a successful unknown classification is durable and idempotent", () => {
  const f = fixture();
  try {
    const id = f.log.start(scope, "local_dev_run", {}, true);
    f.log.markOutcomeUnknown(id);
    f.log.markOutcomeUnknown(id);
    assert.equal(new WorkLogStore(f.db, "boot-two").read(scope).events[0]?.status, "outcome_unknown");
    assert.throws(() => f.log.finish(id, "execution_recorded", {}), code("operation_finished"));
  } finally { f.close(); }
});

test("explicit review remains possible when protected records fill the byte budget", () => {
  const f = fixture({ maxBytes: 3000 });
  try {
    let count = 0;
    assert.throws(() => { while (count++ < 30) f.log.start(scope, "local_dev_run", { path: "p".repeat(450) }, true); }, code("storage_full"));
    const resumed = new WorkLogStore(f.db, "boot-two", { maxBytes: 3000 });
    const ids = resumed.read(scope).events.map((event) => event.id);
    resumed.review(scope, ids, "Inspected disk and running processes. ".repeat(45));
    assert.equal(resumed.summary(scope).reviewRequired, false);
    const id = resumed.start(scope, "local_dev_read_file", {}, false);
    assert.ok(id);
  } finally { f.close(); }
});

test("reopening a different database connection preserves records after an abrupt close", () => {
  const root = mkdtempSync(join(tmpdir(), "local-dev-work-log-reopen-"));
  const path = join(root, "state.sqlite");
  let db = new DatabaseSync(path);
  try {
    const log = new WorkLogStore(db, "boot-one");
    const saved = log.checkpoint(scope, checkpoint);
    const id = log.start(scope, "local_dev_write_file", {}, true);
    db.close();
    db = new DatabaseSync(path);
    const resumed = new WorkLogStore(db, "boot-two");
    assert.deepEqual(resumed.read(scope).checkpoint, saved);
    assert.equal(resumed.read(scope).events[0]?.id, id);
    assert.equal(resumed.read(scope).events[0]?.status, "outcome_unknown");
    assert.equal(resumed.summary(scope).reviewRequired, true);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("metadata secret field names redact plain credential values", () => {
  const f = fixture();
  try {
    f.log.start(scope, "local_dev_read_file", { password: "plain-password-value", accessToken: "plain-token-value", API_KEY: "plain-key-value" }, false);
    const serialized = JSON.stringify(f.log.read(scope));
    assert.equal(serialized.includes("plain-password-value"), false);
    assert.equal(serialized.includes("plain-token-value"), false);
    assert.equal(serialized.includes("plain-key-value"), false);
  } finally { f.close(); }
});

test("quoted JSON credentials are absent from saved checkpoints and persistent rows", () => {
  const f = fixture();
  try {
    const secrets = ['{"password":"fixture-secret"}', '{"api_key": "fixture-key"}'];
    f.log.checkpoint(scope, { ...checkpoint, goal: secrets[0]!, verification: [secrets[1]!] });
    const page = f.log.read(scope);
    const row = f.db.prepare("SELECT payload FROM work_log_checkpoints").get();
    for (const value of [JSON.stringify(page), String(row?.payload)]) {
      assert.equal(value.includes("fixture-secret"), false);
      assert.equal(value.includes("fixture-key"), false);
    }
    const resumed = new WorkLogStore(f.db, "boot-two");
    assert.equal(JSON.stringify(resumed.read(scope)).includes("fixture-secret"), false);
  } finally { f.close(); }
});
