import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChatFolderConnection } from "@local-dev/protocol";
import { BackgroundBrowserController, type BackgroundBrowserInspection, type BackgroundBrowserTarget } from "./background-browser.js";
import { ChatFolderStore } from "./chat-folder-store.js";
import { createLocalDevMcpHandler } from "./mcp.js";
import { SkillCatalog, type SkillSummary } from "./skill-catalog.js";

type Handler = ReturnType<typeof createLocalDevMcpHandler>;
interface RpcReply {
  result?: { isError?: boolean; content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; tools?: Array<{ name: string }> };
  error?: { code: number; message: string };
}

function request(method: string, params: Record<string, unknown>, transportId?: string): Request {
  return new Request("http://localhost/mcp", {
    method: "POST", headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25", ...(transportId ? { "mcp-session-id": transportId } : {}),
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function rpc(handler: Handler, method: string, params: Record<string, unknown>, transportId?: string): Promise<RpcReply> {
  const response = await handler.fetch(request(method, params, transportId));
  assert.equal(response.status, 200);
  const wire = await response.text();
  const text = wire.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? wire;
  return JSON.parse(text) as RpcReply;
}

function call(handler: Handler, name: string, args: Record<string, unknown>, host?: string, transportId?: string) {
  return rpc(handler, "tools/call", { name, arguments: args, ...(host === undefined ? {} : { _meta: { "openai/session": host } }) }, transportId);
}

function success<T>(reply: RpcReply): T {
  assert.equal(reply.error, undefined);
  assert.ok(reply.result);
  assert.notEqual(reply.result.isError, true, JSON.stringify(reply.result));
  const text = reply.result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text);
  return JSON.parse(text) as T;
}

function failure(reply: RpcReply, message?: RegExp) {
  assert.ok(reply.error || reply.result?.isError, JSON.stringify(reply));
  if (message) assert.match(JSON.stringify(reply), message);
}

class MockBrowser extends BackgroundBrowserController {
  currentUrl = "about:blank";
  readonly typed: string[] = [];
  constructor(directory: string, readonly chatId: string) { super(directory); }
  private target(): BackgroundBrowserTarget { return { id: this.chatId, title: this.chatId, url: this.currentUrl, type: "page" }; }
  override async inspect(): Promise<BackgroundBrowserInspection> {
    return { mode: "background", browser: "Brave Browser", target: this.target(), targets: [this.target()], viewport: { width: 1000, height: 800, deviceScaleFactor: 1 } };
  }
  override async navigate(url: string): Promise<BackgroundBrowserTarget> { this.currentUrl = url; return this.target(); }
  override async type(text: string): Promise<void> { this.typed.push(text); }
  override async evaluate<T = unknown>(_expression: string): Promise<T> {
    return { url: this.currentUrl, title: this.chatId, mainText: "Page source text", bodyText: "Body", links: [] } as T;
  }
  override async screenshot(): Promise<Buffer> { return Buffer.from("mock screenshot"); }
}

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "local-dev-mcp-folders-")));
  const folder = join(base, "project");
  const otherFolder = join(base, "other-project");
  const codexHome = join(base, "codex");
  await Promise.all([mkdir(folder), mkdir(otherFolder), mkdir(join(codexHome, "skills", "installed-rule"), { recursive: true }), mkdir(join(folder, ".codex", "skills", "project-rule"), { recursive: true })]);
  await Promise.all([
    writeFile(join(codexHome, "skills", "installed-rule", "SKILL.md"), "---\nname: installed-rule\ndescription: Installed fixture skill\n---\nInstalled skill instructions.\n"),
    writeFile(join(folder, ".codex", "skills", "project-rule", "SKILL.md"), "---\nname: project-rule\ndescription: Project fixture skill\n---\nProject skill instructions.\n"),
    writeFile(join(folder, ".codex", "skills", "project-rule", "reference.md"), "Project skill reference.\n"),
    writeFile(join(folder, "first.txt"), "First project secret"), writeFile(join(otherFolder, "other.txt"), "Other project secret"),
  ]);
  const chats = new ChatFolderStore(join(base, "chat-folders.sqlite"));
  const browsers = new Map<string, MockBrowser>();
  const handler = createLocalDevMcpHandler({
    chats, version: "test", startedAt: new Date().toISOString(), apiUrl: "http://127.0.0.1:0", mcpUrl: "http://127.0.0.1:0/mcp",
    backgroundBrowsers: { forChat: (id) => { let browser = browsers.get(id); if (!browser) { browser = new MockBrowser(base, id); browsers.set(id, browser); } return browser; } },
    skillCatalog: new SkillCatalog({ codexHome, agentsSkillsRoot: join(base, "agents") }),
    tunnelStatus: () => ({ enabled: false, connected: false, provider: null, tunnelId: null, publicEndpoint: null, state: "off", accessConfigured: false, error: null }),
  });
  const connect = async (host: string, selectedFolder = folder) => {
    const chat = chats.observe(host);
    const connected = await chats.connect(chat.id, selectedFolder, chat.revision);
    await saveCheckpoint(handler, host);
    return connected;
  };
  return { base, folder, otherFolder, chats, handler, browsers, connect,
    async close() { await handler.close(); chats.close(); await rm(base, { recursive: true, force: true }); } };
}

async function saveCheckpoint(handler: Handler, host: string) {
  success(await call(handler, "local_dev_work_log", { action: "read" }, host));
  success(await call(handler, "local_dev_work_log", { action: "checkpoint", checkpoint: { goal: "Scoped MCP fixture", completed: [], verification: [], nextStep: "Run scoped assertions", status: "in_progress" } }, host));
}

test("MCP discovers a chat without granting tools before a manual folder selection", async () => {
  const f = await fixture();
  try {
    const setup = success<{ chat: ChatFolderConnection; connected: boolean }>(await call(f.handler, "local_dev_project_setup", { title: "My chat" }, "host-one"));
    assert.equal(setup.chat.title, "My chat");
    assert.equal(setup.chat.folderPath, null);
    assert.equal(setup.connected, false);
    for (const [name, args] of [
      ["local_dev_file_read", { path: "first.txt" }], ["local_dev_file_write", { path: "new.txt", content: "no" }],
      ["local_dev_skills", { action: "list" }], ["local_dev_browser_inspect", {}],
    ] as const) failure(await call(f.handler, name, args, "host-one"), /folder_required/);
    assert.equal(f.browsers.size, 0);
    await f.chats.connect(setup.chat.id, f.folder, setup.chat.revision);
    assert.equal(success<{ content: string }>(await call(f.handler, "local_dev_file_read", { path: "first.txt" }, "host-one")).content, "First project secret");
    failure(await call(f.handler, "local_dev_file_write", { path: "new.txt", content: "no" }, "host-one"), /local_dev_skills/);
  } finally { await f.close(); }
});

test("strict MCP schemas refuse model supplied folder grants and chat switches", async () => {
  const f = await fixture();
  try {
    for (const args of [{ folderPath: f.folder }, { projectPath: f.folder }, { hostThreadId: "host-two" }, { id: "other-chat" }]) {
      failure(await call(f.handler, "local_dev_project_setup", args, "host-one"));
    }
    assert.equal(f.chats.list().length, 0);
    await f.connect("host-one");
    failure(await call(f.handler, "local_dev_file_read", { path: "first.txt", folderPath: f.otherFolder }, "host-one"));
    failure(await call(f.handler, "local_dev_file_read", { path: "first.txt", chatId: "different-chat" }, "host-one"));
    assert.equal(f.chats.getByHost("host-one")?.folderPath, f.folder);
  } finally { await f.close(); }
});

test("two chats sharing one folder require independent skills checks and reconnecting resets the check", async () => {
  const f = await fixture();
  try {
    const first = await f.connect("host-one");
    const second = await f.connect("host-two");
    assert.equal(first.folderPath, second.folderPath);
    success(await call(f.handler, "local_dev_skills", { action: "list" }, "host-one"));
    success(await call(f.handler, "local_dev_file_write", { path: "shared.txt", content: "Shared content" }, "host-one"));
    failure(await call(f.handler, "local_dev_file_write", { path: "blocked.txt", content: "no" }, "host-two"), /local_dev_skills/);
    assert.equal(success<{ content: string }>(await call(f.handler, "local_dev_file_read", { path: "shared.txt" }, "host-two")).content, "Shared content");
    success(await call(f.handler, "local_dev_skills", { action: "list" }, "host-two"));
    success(await call(f.handler, "local_dev_file_edit", { path: "shared.txt", oldText: "Shared", newText: "Edited" }, "host-two"));
    const disconnected = f.chats.disconnect(first.id, first.revision);
    await f.chats.connect(first.id, f.folder, disconnected.revision);
    failure(await call(f.handler, "local_dev_file_write", { path: "blocked-again.txt", content: "no" }, "host-one"), /local_dev_skills/);
    success(await call(f.handler, "local_dev_file_write", { path: "still-authorized.txt", content: "two" }, "host-two"));
    success(await call(f.handler, "local_dev_skills", { action: "list" }, "host-one"));
    await saveCheckpoint(f.handler, "host-one");
    success(await call(f.handler, "local_dev_file_write", { path: "reconnected.txt", content: "one" }, "host-one"));
  } finally { await f.close(); }
});

test("MCP never substitutes transport identity for the host chat identity", async () => {
  const f = await fixture();
  try {
    await f.connect("host-one");
    const initialized = await f.handler.fetch(request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } }));
    assert.equal(initialized.status, 200);
    const transportId = initialized.headers.get("mcp-session-id");
    assert.ok(transportId);
    await initialized.text();
    failure(await call(f.handler, "local_dev_file_read", { path: "first.txt" }, undefined, transportId), /chat.*identity/);
    assert.equal(f.chats.list().length, 1);
    assert.equal(success<{ content: string }>(await call(f.handler, "local_dev_file_read", { path: "first.txt" }, "host-one", transportId)).content, "First project secret");
    failure(await call(f.handler, "local_dev_file_read", { path: "first.txt" }, "host-two", transportId), /folder_required/);
    assert.equal(f.chats.getByHost("host-two")?.folderPath, null);
    assert.equal(f.chats.list().length, 2);
  } finally { await f.close(); }
});

test("MCP scopes files and status to each chat's selected folder", async () => {
  const f = await fixture();
  try {
    const first = await f.connect("host-one");
    await f.connect("host-two", f.otherFolder);
    await symlink(f.folder, join(f.otherFolder, "escape"));
    for (const path of [join(f.folder, "first.txt"), "../project/first.txt", "escape/first.txt"]) {
      failure(await call(f.handler, "local_dev_file_read", { path }, "host-two"), /scope/);
    }
    assert.equal(success<{ content: string }>(await call(f.handler, "local_dev_file_read", { path: "other.txt" }, "host-two")).content, "Other project secret");
    const status = success<{ chat: ChatFolderConnection; connected: boolean }>(await call(f.handler, "local_dev_status", {}, "host-one"));
    assert.equal(status.chat.id, first.id);
    assert.equal(status.connected, true);
    assert.equal("chats" in status, false);
    assert.equal("sessions" in status, false);
    assert.equal(JSON.stringify(status).includes(f.otherFolder), false);
  } finally { await f.close(); }
});

test("MCP exposes folder tools and skills without worker, primary or continuation actions", async () => {
  const f = await fixture();
  try {
    const listed = await rpc(f.handler, "tools/list", {});
    const names = listed.result?.tools?.map((tool) => tool.name) ?? [];
    assert.ok(names.includes("local_dev_project_setup"));
    assert.ok(names.includes("local_dev_skills"));
    assert.ok(names.includes("local_dev_shell"));
    assert.equal(names.some((name) => /worker|primary|continuation|compaction|auto_continue|continuous|team/.test(name)), false);
    for (const name of ["local_dev_session_register", "local_dev_team_create", "local_dev_worker_claim", "local_dev_apple_worker", "local_dev_primary_desktop_bind_active", "local_dev_primary_continuation_claim", "local_dev_auto_continue_policy"]) {
      failure(await call(f.handler, name, {}, "host-one"));
    }
    assert.equal(f.chats.list().length, 0);
  } finally { await f.close(); }
});

test("MCP reads project and installed skills and their scoped supporting resources", async () => {
  const f = await fixture();
  try {
    await f.connect("host-one");
    await f.connect("host-two", f.otherFolder);
    const catalog = success<{ skills: SkillSummary[]; total: number }>(await call(f.handler, "local_dev_skills", { action: "list" }, "host-one"));
    assert.equal(catalog.total, 2);
    const project = catalog.skills.find((skill) => skill.name === "project-rule");
    const installed = catalog.skills.find((skill) => skill.name === "installed-rule");
    assert.ok(project); assert.ok(installed);
    assert.equal(project.source, "project");
    assert.equal(installed.source, "codex");
    assert.match(success<{ content: string }>(await call(f.handler, "local_dev_skills", { action: "read", id: project.id }, "host-one")).content, /Project skill instructions/);
    assert.match(success<{ content: string }>(await call(f.handler, "local_dev_skills", { action: "read", id: installed.id }, "host-one")).content, /Installed skill instructions/);
    assert.equal(success<{ content: string }>(await call(f.handler, "local_dev_skills", { action: "read", id: project.id, resource: "reference.md" }, "host-one")).content, "Project skill reference.\n");
    failure(await call(f.handler, "local_dev_skills", { action: "read", id: project.id }, "host-two"), /Unknown skill ID/);
    failure(await call(f.handler, "local_dev_skills", { action: "read", id: project.id, resource: "../SKILL.md" }, "host-one"), /traversal/);
  } finally { await f.close(); }
});

test("MCP browser state belongs to individual chats even when they share a folder", async () => {
  const f = await fixture();
  try {
    const first = await f.connect("host-one");
    const second = await f.connect("host-two");
    success(await call(f.handler, "local_dev_browser_control", { action: "navigate", url: "https://example.com/first" }, "host-one"));
    const fresh = success<BackgroundBrowserInspection>(await call(f.handler, "local_dev_browser_inspect", {}, "host-two"));
    assert.equal(fresh.target.url, "about:blank");
    success(await call(f.handler, "local_dev_browser_control", { action: "type", text: "First chat text" }, "host-one"));
    assert.deepEqual(f.browsers.get(`${first.id}:${first.revision}`)?.typed, ["First chat text"]);
    assert.deepEqual(f.browsers.get(`${second.id}:${second.revision}`)?.typed, []);
    const opened = success<{ url: string; text: string; sourceNotice: string }>(await call(f.handler, "local_dev_web_open", { url: "https://example.com/second" }, "host-two"));
    assert.equal(opened.url, "https://example.com/second");
    assert.equal(opened.text, "Page source text");
    assert.match(opened.sourceNotice, /source material/);
    assert.equal(f.browsers.get(`${first.id}:${first.revision}`)?.currentUrl, "https://example.com/first");
    const screenshots = await Promise.all([call(f.handler, "local_dev_browser_control", { action: "screenshot" }, "host-one"), call(f.handler, "local_dev_browser_control", { action: "screenshot" }, "host-two")]);
    const paths = screenshots.map((reply) => success<{ path: string }>(reply).path);
    assert.notEqual(paths[0], paths[1]);
    for (const [index, reply] of screenshots.entries()) {
      assert.ok(reply.result?.content?.some((item) => item.type === "image" && item.mimeType === "image/png"));
      assert.equal((await readFile(paths[index]!)).toString(), "mock screenshot");
    }
    failure(await call(f.handler, "local_dev_browser_control", { action: "navigate", url: "file:///etc/passwd" }, "host-one"), /HTTP/);
    const reassigned = await f.chats.connect(first.id, f.otherFolder, first.revision);
    const afterReassignment = success<BackgroundBrowserInspection>(await call(f.handler, "local_dev_browser_inspect", {}, "host-one"));
    assert.equal(afterReassignment.target.url, "about:blank");
    assert.ok(f.browsers.has(`${first.id}:${reassigned.revision}`));
  } finally { await f.close(); }
});
