import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatFolderStore } from "./chat-folder-store.js";
import { createLocalDevMcpHandler } from "./mcp.js";
import { SkillCatalog } from "./skill-catalog.js";

type Handler = ReturnType<typeof createLocalDevMcpHandler>;
type Reply = { result?: { isError?: boolean; content: Array<{ type: string; text?: string }> }; error?: unknown };
async function call(handler: Handler, name: string, args: Record<string, unknown>, host = "host-one") {
  const response = await handler.fetch(new Request("http://localhost/mcp", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: { "openai/session": host } } }),
  }));
  const wire = await response.text();
  return JSON.parse(wire.split("\n").find(line => line.startsWith("data: "))?.slice(6) ?? wire) as Reply;
}
function success(reply: Reply): any {
  assert.equal(reply.error, undefined);
  assert.notEqual(reply.result?.isError, true, JSON.stringify(reply));
  return JSON.parse(reply.result!.content.find(item => item.type === "text")!.text!);
}
const checkpoint = { goal: "Build fixture", completed: [], verification: [], nextStep: "Write canary", status: "in_progress" };
async function fixture(options?: ConstructorParameters<typeof ChatFolderStore>[1]) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "local-dev-recovery-")));
  const folder = join(base, "project"); await mkdir(folder);
  let chats = new ChatFolderStore(join(base, "chats.sqlite"), options);
  const createHandler = () => createLocalDevMcpHandler({ chats, version: "test", startedAt: new Date().toISOString(), apiUrl: "http://127.0.0.1:0", mcpUrl: "http://127.0.0.1:0/mcp",
    backgroundBrowsers: { forChat: () => { throw new Error("No browser fixture"); } },
    skillCatalog: new SkillCatalog({ codexHome: join(base, "codex"), agentsSkillsRoot: join(base, "agents") }),
    tunnelStatus: () => ({ enabled: false, connected: false, provider: null, tunnelId: null, publicEndpoint: null, state: "off", accessConfigured: false, error: null }),
  });
  let handler = createHandler();
  const connect = async (host: string) => { const chat = chats.observe(host); return chats.connect(chat.id, folder, chat.revision); };
  const f = { base, folder, get chats() { return chats; }, get handler() { return handler; }, connect,
    async restart() { await handler.close(); chats.close(); chats = new ChatFolderStore(join(base, "chats.sqlite")); handler = createHandler(); },
    async close() { await handler.close(); chats.close(); await rm(base, { recursive: true, force: true }); },
  };
  return f;
}

test("first mutation requires a checkpoint and history records execution without private contents", async () => {
  const f = await fixture();
  try {
    const chat = await f.connect("host-one");
    success(await call(f.handler, "local_dev_skills", { action: "list" }));
    const blocked = await call(f.handler, "local_dev_file_write", { path: "canary.txt", content: "private canary contents" });
    assert.equal(blocked.result?.isError, true);
    assert.match(JSON.stringify(blocked), /work_checkpoint_required/);
    success(await call(f.handler, "local_dev_work_log", { action: "read" }));
    success(await call(f.handler, "local_dev_work_log", { action: "checkpoint", checkpoint }));
    success(await call(f.handler, "local_dev_file_write", { path: "canary.txt", content: "private canary contents" }));
    const log = success(await call(f.handler, "local_dev_work_log", { action: "read" }));
    assert.equal(log.checkpoint.goal, checkpoint.goal);
    const event = log.events.find((e: any) => e.tool === "local_dev_file_write");
    assert.equal(event.status, "execution_recorded");
    assert.equal(event.metadata.path, "canary.txt");
    assert.match(event.metadata.stagePath, /^\.local-dev-stage-.*\.tmp$/);
    assert.equal(event.metadata.stagePhase, "committed");
    assert.match(event.metadata.stageInode, /^\d+$/);
    assert.ok(!JSON.stringify(log).includes("private canary contents"));
    assert.equal(await readFile(join(f.folder, "canary.txt"), "utf8"), "private canary contents");
    assert.equal(f.chats.workLog.summary({ chatId: chat.id, revision: chat.revision }).unresolvedOperations, 0);
  } finally { await f.close(); }
});

test("restarted work needs history review and unknown side effects must be explicitly acknowledged", async () => {
  const f = await fixture();
  try {
    const chat = await f.connect("host-one");
    const id = f.chats.workLog.start({ chatId: chat.id, revision: chat.revision, projectPath: f.folder, hostThreadId: "host-one" }, "local_dev_shell", {}, true);
    await f.restart();
    success(await call(f.handler, "local_dev_skills", { action: "list" }));
    assert.equal((await call(f.handler, "local_dev_shell", { command: "true" })).result?.isError, true);
    assert.equal((await call(f.handler, "local_dev_work_log", { action: "checkpoint", checkpoint })).result?.isError, true);
    const log = success(await call(f.handler, "local_dev_work_log", { action: "read" }));
    assert.equal(log.events.find((e: any) => e.id === id).status, "outcome_unknown");
    assert.equal((await call(f.handler, "local_dev_work_log", { action: "checkpoint", checkpoint })).result?.isError, true);
    assert.equal((await call(f.handler, "local_dev_file_read", { path: "." })).result?.isError, true);
    success(await call(f.handler, "local_dev_work_log", { action: "checkpoint", checkpoint, reviewedOperationIds: [id], reviewNote: "Inspected workspace; safe to continue without replaying the command." }));
    success(await call(f.handler, "local_dev_file_write", { path: "recovered.txt", content: "recovered" }));
    const reviewed = success(await call(f.handler, "local_dev_work_log", { action: "read" })).events.find((e: any) => e.id === id);
    assert.equal(reviewed.status, "outcome_unknown");
    assert.ok(reviewed.reviewedAt);
  } finally { await f.close(); }
});

test("shared folders keep chat histories private and folder changes hide older work", async () => {
  const f = await fixture();
  try {
    const first = await f.connect("host-one"); await f.connect("host-two");
    success(await call(f.handler, "local_dev_work_log", { action: "checkpoint", checkpoint }));
    const second = success(await call(f.handler, "local_dev_work_log", { action: "read" }, "host-two"));
    assert.equal(second.checkpoint, null); assert.equal(second.events.length, 0);
    assert.equal((await call(f.handler, "local_dev_work_log", { action: "read", chatId: first.id }, "host-two")).result?.isError, true);
    const other = join(f.base, "other"); await mkdir(other);
    await f.chats.connect(first.id, other, first.revision);
    assert.equal(success(await call(f.handler, "local_dev_work_log", { action: "read" })).checkpoint, null);
    assert.equal((await call(f.handler, "local_dev_work_log", { action: "read", revision: first.revision })).result?.isError, true);
  } finally { await f.close(); }
});

test("logging failures block mutation before execution, but preserve an executed result", async () => {
  let fail: string | null = null;
  const f = await fixture({ workLog: { beforeWrite: phase => { if (phase === fail) throw new Error("injected storage failure"); } } });
  try {
    await f.connect("host-one");
    success(await call(f.handler, "local_dev_skills", { action: "list" }));
    success(await call(f.handler, "local_dev_work_log", { action: "read" }));
    success(await call(f.handler, "local_dev_work_log", { action: "checkpoint", checkpoint }));
    fail = "start";
    assert.equal((await call(f.handler, "local_dev_file_write", { path: "not-written.txt", content: "no" })).result?.isError, true);
    await assert.rejects(readFile(join(f.folder, "not-written.txt")), { code: "ENOENT" });
    fail = "stage";
    assert.equal((await call(f.handler, "local_dev_file_write", { path: "not-committed.txt", content: "no" })).result?.isError, true);
    await assert.rejects(readFile(join(f.folder, "not-committed.txt")), { code: "ENOENT" });
    fail = null;
    const failedStage = success(await call(f.handler, "local_dev_work_log", { action: "read" })).events.find((e: any) => e.tool === "local_dev_file_write");
    success(await call(f.handler, "local_dev_work_log", { action: "checkpoint", checkpoint, reviewedOperationIds: [failedStage.id], reviewNote: "The failed stage did not replace the file; inspected destination." }));
    fail = "finish";
    const reply = await call(f.handler, "local_dev_file_write", { path: "written.txt", content: "yes" });
    assert.equal(success(reply).bytes, 3);
    assert.match(JSON.stringify(reply), /executed.*history|history.*executed/i);
    assert.equal(await readFile(join(f.folder, "written.txt"), "utf8"), "yes");
    // An unfinished journal record must stop another blind mutation in this same run.
    assert.equal((await call(f.handler, "local_dev_file_write", { path: "next.txt", content: "no" })).result?.isError, true);
    fail = null;
  } finally { fail = null; await f.close(); }
});

test("a nonzero command is an execution error even when MCP returns its normal output envelope", async () => {
  const f = await fixture();
  try {
    await f.connect("host-one");
    success(await call(f.handler, "local_dev_skills", { action: "list" }));
    success(await call(f.handler, "local_dev_work_log", { action: "read" }));
    success(await call(f.handler, "local_dev_work_log", { action: "checkpoint", checkpoint }));
    assert.equal(success(await call(f.handler, "local_dev_shell", { command: "exit 9" })).exitCode, 9);
    const log = success(await call(f.handler, "local_dev_work_log", { action: "read" }));
    const event = log.events.find((e: any) => e.tool === "local_dev_shell");
    assert.equal(event.status, "execution_error"); assert.equal(event.result.exitCode, 9);
    assert.equal(log.summary.reviewRequired, true);
  } finally { await f.close(); }
});

test("a post-rename staging history failure preserves the actual saved result", async () => {
  let writes = 0;
  const f = await fixture({ workLog: { beforeWrite: phase => { if (phase === "stage" && ++writes === 3) throw new Error("final stage history unavailable"); } } });
  try {
    await f.connect("host-one");
    success(await call(f.handler, "local_dev_skills", { action: "list" }));
    success(await call(f.handler, "local_dev_work_log", { action: "read" }));
    success(await call(f.handler, "local_dev_work_log", { action: "checkpoint", checkpoint }));
    const reply = await call(f.handler, "local_dev_file_write", { path: "saved.txt", content: "complete save" });
    assert.equal(success(reply).bytes, 13);
    assert.match(JSON.stringify(reply), /file save executed/);
    assert.equal(await readFile(join(f.folder, "saved.txt"), "utf8"), "complete save");
    const event = success(await call(f.handler, "local_dev_work_log", { action: "read" })).events.find((item: any) => item.tool === "local_dev_file_write");
    assert.equal(event.status, "execution_recorded");
  } finally { await f.close(); }
});
