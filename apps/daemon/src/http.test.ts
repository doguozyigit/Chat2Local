import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import test from "node:test";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { ChatFolderStore } from "./chat-folder-store.js";
import { createLocalHttpServer } from "./http.js";
import { TunnelManager } from "./tunnel-manager.js";
import { loadOrCreateApiToken } from "./api-auth.js";
const token = "local-dev-test-token";

async function fixture() {
  const data = mkdtempSync(join(tmpdir(), "local-dev-http-"));
  const chats = new ChatFolderStore(":memory:");
  const server = createLocalHttpServer({ host: "127.0.0.1", port: 0, version: "test", startedAt: new Date().toISOString(), chats,
    tunnel: new TunnelManager("http://127.0.0.1:0/mcp", data), authToken: token,
    mcpHandler: { fetch: async () => new Response(null, { status: 404 }) } as unknown as McpHttpHandler });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  return { data, chats, base,
    fetch: (path: string, options: RequestInit = {}) => fetch(base + path, { ...options, headers: { "x-local-dev-token": token, ...options.headers } }),
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())); chats.close(); rmSync(data, { recursive: true, force: true }); },
  };
}

test("API token persists privately and rejects unsafe files", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-dev-auth-"));
  try {
    const first = loadOrCreateApiToken(directory); const path = join(directory, "api-token");
    assert.match(first, /^[0-9a-f]{64}$/); assert.equal(readFileSync(path, "utf8").trim(), first);
    assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(loadOrCreateApiToken(directory), first);
    chmodSync(path, 0o644); assert.throws(() => loadOrCreateApiToken(directory), /permissions/i);
    rmSync(path); symlinkSync("/etc/hosts", path); assert.throws(() => loadOrCreateApiToken(directory), /regular file|symbolic link/i);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("HTTP rejects missing/incorrect tokens, origins and forged hosts", async () => {
  const f = await fixture();
  try {
    for (const path of ["/v1/status", "/v1/chats", "/mcp"]) {
      assert.equal((await fetch(f.base + path)).status, 401);
      assert.equal((await f.fetch(path, { headers: { "x-local-dev-token": "incorrect" } })).status, 401);
    }
    assert.equal((await f.fetch("/v1/status")).status, 200);
    assert.equal((await f.fetch("/v1/status", { headers: { origin: "https://example.com" } })).status, 403);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(f.base + "/v1/status", { headers: { host: "malicious.example", "x-local-dev-token": token } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
      req.on("error", reject); req.end();
    });
    assert.equal(status, 403);
  } finally { await f.close(); }
});

test("manual folder endpoints allow shared folders, reject stale selection and disconnect one chat", async () => {
  const f = await fixture();
  try {
    const first = f.chats.observe("chat-a", "First"); const second = f.chats.observe("chat-b", "Second");
    const put = (id: string, expectedRevision: number, folderPath = f.data) => f.fetch(`/v1/chats/${id}/folder`, { method: "PUT", body: JSON.stringify({ folderPath, expectedRevision }) });
    assert.equal((await put(first.id, 0)).status, 200); assert.equal((await put(second.id, 0)).status, 200);
    const state = await (await f.fetch("/v1/status")).json();
    assert.equal(state.chats.length, 2); assert.equal(state.chats[0].folderPath, state.chats[1].folderPath);
    assert.equal("sessions" in state, false); assert.equal("workers" in state, false);
    assert.equal((await put(first.id, 0)).status, 409);
    assert.equal((await put("unknown", 0)).status, 404);
    assert.equal((await put(second.id, 1, join(f.data, "missing"))).status, 400);
    assert.equal((await f.fetch(`/v1/chats/${first.id}/disconnect`, { method: "POST", body: JSON.stringify({ expectedRevision: 1 }) })).status, 200);
    assert.equal(f.chats.get(first.id)?.folderPath, null); assert.ok(f.chats.get(second.id)?.folderPath);
  } finally { await f.close(); }
});

test("HTTP retired orchestration endpoints are absent", async () => {
  const f = await fixture();
  try {
    for (const path of ["/v1/sessions", "/v1/project-bindings", "/v1/workers", "/v1/apple-workers", "/v1/sessions/old/desktop-binding", "/v1/sessions/old/compact", "/v1/sessions/old/auto-continue/arm"]) {
      assert.equal((await f.fetch(path, { method: "POST", body: "{}" })).status, 404, path);
    }
  } finally { await f.close(); }
});

test("owner recovery routes paginate revisions and clear only safe history behind authenticated access", async () => {
  const f = await fixture();
  try {
    const first = f.chats.observe("history-first"); const second = f.chats.observe("history-second");
    const chat = await f.chats.connect(first.id, f.data, first.revision);
    const scope = { chatId: chat.id, revision: chat.revision, projectPath: f.data };
    const checkpoint = f.chats.workLog.checkpoint(scope, { goal: "Fixture recovery", completed: [], verification: [], nextStep: "Inspect files", status: "in_progress" });
    const done = f.chats.workLog.start(scope, "local_dev_file_read", { path: "one.txt" }, false); f.chats.workLog.finish(done, "execution_recorded", {});
    const failed = f.chats.workLog.start(scope, "local_dev_shell", {}, true); f.chats.workLog.finish(failed, "execution_error", { exitCode: 1 });
    const running = f.chats.workLog.start(scope, "local_dev_shell", {}, true);
    const path = `/v1/chats/${chat.id}/work-log`;
    assert.equal((await fetch(f.base + path)).status, 401);
    const status = await (await f.fetch("/v1/status")).json();
    const summary = status.chats.find((item: any) => item.id === chat.id).recovery;
    assert.equal(summary.reviewRequired, true); assert.equal(summary.activeOperations, 1);
    assert.ok(!JSON.stringify(status).includes("Fixture recovery"));
    const page = await (await f.fetch(path + "?limit=1")).json();
    assert.equal(page.events.length, 1); assert.equal(page.events[0].id, running); assert.ok(page.nextBeforeSequence);
    const older = await (await f.fetch(path + `?beforeSequence=${page.nextBeforeSequence}&limit=1`)).json();
    assert.equal(older.events[0].id, failed);
    const empty = await (await f.fetch(`/v1/chats/${second.id}/work-log`)).json(); assert.equal(empty.checkpoint, null);
    for (const query of ["limit=0", "limit=201", "beforeSequence=-1", "folderPath=/tmp", "revision=999999", "limit=hello"]) assert.equal((await f.fetch(path + "?" + query)).status, 400);
    f.chats.disconnect(chat.id, chat.revision);
    assert.equal((await f.fetch(path + "/clear", { method: "POST", body: JSON.stringify({ revision: chat.revision, expectedRevision: chat.revision }) })).status, 409);
    const history = await (await f.fetch(path + "/revisions")).json(); assert.equal(history.revisions[0].revision, chat.revision);
    const cleared = await (await f.fetch(path + "/clear", { method: "POST", body: JSON.stringify({ revision: chat.revision, expectedRevision: chat.revision + 1 }) })).json();
    assert.equal(cleared.removed, 1);
    const retained = await (await f.fetch(path + `?revision=${chat.revision}`)).json();
    assert.equal(retained.checkpoint.sequence, checkpoint.sequence); assert.deepEqual(new Set(retained.events.map((event: any) => event.id)), new Set([failed, running]));
  } finally { await f.close(); }
});

test("malformed targets, JSON and oversized bodies do not stop the service", async () => {
  const f = await fixture();
  try {
    const chat = f.chats.observe("malformed-chat");
    const native = (path: string) => new Promise<number>((resolve, reject) => {
      const req = request(f.base, { path, headers: { "x-local-dev-token": token } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); }); req.on("error", reject); req.end();
    });
    assert.equal(await native("//malicious.example/v1/status"), 400);
    assert.equal(await native("/v1/chats/%ZZ/folder"), 400);
    assert.equal((await f.fetch(`/v1/chats/${chat.id}/folder`, { method: "PUT", body: "{" })).status, 400);
    assert.equal((await f.fetch(`/v1/chats/${chat.id}/folder`, { method: "PUT", body: "x".repeat(20000) })).status, 413);
    assert.equal((await f.fetch("/v1/status")).status, 200);
  } finally { await f.close(); }
});

test("history clearing rechecks the selected folder after a delayed request body", async () => {
  const f = await fixture();
  try {
    const original = f.chats.observe("slow-clear"); const chat = await f.chats.connect(original.id, f.data, original.revision);
    const scope = { chatId: chat.id, revision: chat.revision, projectPath: f.data };
    const id = f.chats.workLog.start(scope, "local_dev_list", {}, false); f.chats.workLog.finish(id, "execution_recorded", {});
    const body = JSON.stringify({ revision: chat.revision, expectedRevision: chat.revision });
    let nativeRequest: ReturnType<typeof request>;
    const reply = new Promise<number>((resolve, reject) => {
      nativeRequest = request(f.base + `/v1/chats/${chat.id}/work-log/clear`, { method: "POST", headers: { "x-local-dev-token": token, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
      nativeRequest.on("error", reject); nativeRequest.flushHeaders(); nativeRequest.write(body.slice(0, 1));
    });
    // The handler has received headers, but cannot parse the incomplete body yet.
    await new Promise(resolve => setTimeout(resolve, 30));
    f.chats.disconnect(chat.id, chat.revision);
    nativeRequest!.end(body.slice(1));
    assert.equal(await reply, 409);
    assert.equal(f.chats.workLog.read(scope).events.length, 1);
  } finally { await f.close(); }
});
