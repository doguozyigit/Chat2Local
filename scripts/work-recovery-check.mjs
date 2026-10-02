#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function waitUntil(probe, label) {
  for (let attempt = 0; attempt < 160; attempt++) { if (await probe()) return; await delay(25); }
  throw new Error(`Recovery acceptance timed out: ${label}`);
}

/** Real service, private disposable state, authenticated MCP; never opens an app or uses a tunnel. */
export async function runWorkRecoveryCheck({ node = process.execPath, daemon = join(root, "apps/daemon/dist/index.js") } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "local-dev-interruption-"));
  const data = join(directory, "data"); const folder = join(directory, "project");
  await mkdir(folder); await mkdir(data, { mode: 0o700 });
  const skillDir = join(folder, ".agents/skills/recovery-fixture"); await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: recovery-fixture\ndescription: Disposable interruption acceptance\n---\nInspect state before repeating an interrupted command.\n");
  const probe = createServer(); await new Promise(resolveListen => probe.listen(0, "127.0.0.1", resolveListen));
  const port = probe.address().port; await new Promise(resolveClose => probe.close(resolveClose));
  const endpoint = `http://127.0.0.1:${port}`;
  let service; let exited; let token; let id = 0; const checks = [];
  const checkpoint = { goal: "Recover disposable fixture", completed: [], verification: [], nextStep: "Inspect and continue", status: "in_progress" };
  const packet = (name, args, host = "recovery-first") => ({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args, _meta: { "openai/session": host } } });
  const options = { env: { ...process.env, LOCAL_DEV_DATA_DIR: data, LOCAL_DEV_PORT: String(port), LOCAL_DEV_CHAT_FOLDERS_DATABASE: join(data, "chat-folders.sqlite"), LOCAL_DEV_PARENT_PID: undefined }, detached: true, stdio: ["ignore", "ignore", "pipe"] };
  const headers = () => ({ "x-local-dev-token": token, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" });
  const owner = (path, init = {}) => fetch(endpoint + path, { ...init, headers: { "x-local-dev-token": token, "content-type": "application/json" }, signal: AbortSignal.timeout(5000) });
  async function call(name, args, host) {
    const response = await fetch(endpoint + "/mcp", { method: "POST", headers: headers(), body: JSON.stringify(packet(name, args, host)), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); const wire = await response.text();
    return JSON.parse(wire.split("\n").find(line => line.startsWith("data: "))?.slice(6) ?? wire);
  }
  const success = reply => { assert.ok(reply.result && !reply.error && !reply.result.isError, JSON.stringify(reply)); return JSON.parse(reply.result.content[0].text); };
  const denied = reply => assert.ok(reply.error || reply.result?.isError === true);
  async function start() {
    service = spawn(node, [resolve(daemon)], options); service.stderr.on("data", () => {});
    exited = new Promise(resolveExit => service.once("exit", resolveExit));
    await waitUntil(async () => { assert.equal(service.exitCode, null, "Disposable service exited early"); try { if (!(await fetch(endpoint + "/health", { signal: AbortSignal.timeout(200) })).ok) return false; token = (await readFile(join(data, "api-token"), "utf8")).trim(); return true; } catch { return false; } }, "service start");
  }
  async function stop(signal = "SIGTERM") {
    if (!service || service.exitCode !== null || service.signalCode !== null) return;
    // This fixture owns a dedicated process group, including its bounded shell command.
    process.kill(-service.pid, signal);
    await Promise.race([exited, delay(2000)]);
    if (service.exitCode === null && service.signalCode === null) { process.kill(-service.pid, "SIGKILL"); await exited; }
  }
  async function prepare(host = "recovery-first") {
    success(await call("local_dev_skills", { action: "list", query: "recovery-fixture" }, host));
    success(await call("local_dev_work_log", { action: "read" }, host));
    success(await call("local_dev_work_log", { action: "checkpoint", checkpoint }, host));
  }
  async function beginDropped(command, marker) {
    const socketRequest = request(endpoint + "/mcp", { method: "POST", headers: headers() }); socketRequest.on("error", () => {}); socketRequest.on("response", response => response.resume());
    socketRequest.end(JSON.stringify(packet("local_dev_shell", { command, timeoutMs: 4000 })));
    await waitUntil(async () => { try { return (await readFile(join(folder, marker), "utf8")) === "once\n"; } catch { return false; } }, "local command reached marker");
    socketRequest.destroy(); return socketRequest;
  }
  try {
    await start();
    const chat = success(await call("local_dev_project_setup", { title: "Disposable recovery acceptance" })).chat;
    assert.ok((await owner(`/v1/chats/${chat.id}/folder`, { method: "PUT", body: JSON.stringify({ folderPath: folder, expectedRevision: chat.revision }) })).ok);
    await prepare();
    await beginDropped("printf 'once\\n' >> lost-response.txt; sleep 0.3", "lost-response.txt");
    await waitUntil(async () => success(await call("local_dev_work_log", { action: "read" })).events.some(event => event.tool === "local_dev_shell" && event.status === "execution_recorded"), "dropped response completion");
    assert.equal(await readFile(join(folder, "lost-response.txt"), "utf8"), "once\n");
    checks.push("dropped MCP response preserves execution history without replay");
    await beginDropped("printf 'once\\n' >> interrupted.txt; sleep 3", "interrupted.txt");
    const before = success(await call("local_dev_work_log", { action: "read" }));
    const interrupted = before.events.find(event => event.tool === "local_dev_shell" && event.status === "started"); assert.ok(interrupted);
    await stop("SIGKILL"); await start();
    const recovered = success(await call("local_dev_work_log", { action: "read" }));
    assert.equal(recovered.checkpoint.goal, checkpoint.goal);
    const event = recovered.events.find(item => item.id === interrupted.id); assert.equal(event.status, "outcome_unknown"); assert.equal(recovered.summary.reviewRequired, true);
    assert.equal(await readFile(join(folder, "interrupted.txt"), "utf8"), "once\n");
    checks.push("SIGKILL preserves checkpoint and classifies unfinished execution as unknown");
    success(await call("local_dev_skills", { action: "list", query: "recovery-fixture" }));
    denied(await call("local_dev_file_write", { path: "blocked.txt", content: "not allowed" }));
    const inspection = success(await call("local_dev_file_read", { path: "interrupted.txt" })); assert.equal(inspection.content, "once\n");
    success(await call("local_dev_work_log", { action: "checkpoint", checkpoint, reviewedOperationIds: [event.id], reviewNote: "Inspected marker: executed once. Do not repeat the interrupted command." }));
    success(await call("local_dev_file_write", { path: "recovered.txt", content: "continued safely" }));
    assert.equal(await readFile(join(folder, "interrupted.txt"), "utf8"), "once\n");
    checks.push("inspection and explicit review permit safe continuation without blind replay");
    const other = success(await call("local_dev_project_setup", {}, "recovery-second")).chat;
    assert.ok((await owner(`/v1/chats/${other.id}/folder`, { method: "PUT", body: JSON.stringify({ folderPath: folder, expectedRevision: other.revision }) })).ok);
    const isolated = success(await call("local_dev_work_log", { action: "read" }, "recovery-second")); assert.equal(isolated.checkpoint, null); assert.deepEqual(isolated.events, []);
    checks.push("two chats sharing a folder retain separate recovery records");
    await stop(); await start();
    const final = success(await call("local_dev_work_log", { action: "read" }));
    const unknown = final.events.find(item => item.id === event.id); assert.equal(unknown.status, "outcome_unknown"); assert.ok(unknown.reviewedAt); assert.equal(final.summary.reviewRequired, false);
    success(await call("local_dev_skills", { action: "list", query: "recovery-fixture" }));
    denied(await call("local_dev_file_write", { path: "new-run.txt", content: "checkpoint required again" }));
    checks.push("graceful restart preserves review and requires a fresh checkpoint");
    return { passed: true, checks };
  } finally { await stop(); await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const daemonFlag = process.argv.indexOf("--daemon");
  try { const report = await runWorkRecoveryCheck(daemonFlag >= 0 ? { daemon: process.argv[daemonFlag + 1] } : {}); console.log(JSON.stringify(report, null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "Recovery acceptance failed"); process.exitCode = 1; }
}
