#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const expectedTools = [
  "local_dev_status", "local_dev_project_setup", "local_dev_capabilities", "local_dev_skills", "local_dev_work_log",
  "local_dev_file_read", "local_dev_file_write", "local_dev_file_edit", "local_dev_list",
  "local_dev_search", "local_dev_shell", "local_dev_web_open", "local_dev_browser_inspect",
  "local_dev_browser_control", "local_dev_image_import",
].sort();

function argumentsFor(argv) {
  const options = { app: join(repoRoot, "dist", "Chat2Local.app"), report: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") { options.help = true; continue; }
    if (argument !== "--app" && argument !== "--report") throw new Error("Use --app <app path> or --report <JSON filename>.");
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path.`);
    options[argument === "--app" ? "app" : "report"] = resolve(value);
  }
  return options;
}

async function vacantPort() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveListen);
  });
  const address = probe.address();
  assert.ok(address && typeof address === "object", "Could not reserve a disposable service port.");
  await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

const pause = (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
async function waitForExit(exited, milliseconds) {
  let timer;
  try {
    await Promise.race([exited, new Promise((resolveWait) => { timer = setTimeout(resolveWait, milliseconds); })]);
  } finally { clearTimeout(timer); }
}

async function run(options) {
  const passed = [];
  let version;
  let currentStep = "locate packaged app";
  let temporaryDirectory;
  let service;
  let serviceExit;
  let stopPromise;
  let interrupted = false;
  let nextId = 0;
  const interrupt = () => { interrupted = true; void stopService(); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  function check(condition, message) { assert.ok(condition, message); }
  async function step(name, operation) {
    currentStep = name;
    check(!interrupted, "The check was interrupted.");
    await operation();
    passed.push(name);
  }
  function stopService() {
    if (stopPromise) return stopPromise;
    const child = service;
    const exited = serviceExit;
    if (!child || !exited) return Promise.resolve();
    stopPromise = (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await waitForExit(exited, 5_000);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await waitForExit(exited, 3_000);
        }
      }
    })();
    return stopPromise;
  }

  try {
    const resources = join(options.app, "Contents", "Resources");
    const node = join(resources, "node");
    const daemon = join(resources, "local-devd.mjs");
    const bridgePath = join(resources, "local-dev-plugin", "scripts", "mcp-stdio-bridge.mjs");
    await step("packaged runtime and bridge available", async () => {
      await Promise.all([access(node), access(daemon), access(bridgePath)]);
      const runtime = await execute(node, ["--version"], { timeout: 10_000, maxBuffer: 1024 });
      check(/^v(?:2[4-9]|[3-9]\d)\./.test(runtime.stdout.trim()), "Packaged Node.js 24 or later is required.");
    });
    const { startBridge } = await import(pathToFileURL(bridgePath).href);
    check(typeof startBridge === "function", "The packaged MCP bridge is missing its entry point.");
    temporaryDirectory = await mkdtemp(join(tmpdir(), "local-dev-fresh-install-"));
    const dataDirectory = join(temporaryDirectory, "data");
    const projectDirectory = join(temporaryDirectory, "hello-local-dev");
    await mkdir(dataDirectory, { mode: 0o700 });
    await cp(join(repoRoot, "examples", "hello-local-dev"), projectDirectory, { recursive: true });
    const canonicalProject = await realpath(projectDirectory);
    await access(join(projectDirectory, ".agents", "skills", "local-demo", "SKILL.md"));
    const port = await vacantPort();
    const endpoint = `http://127.0.0.1:${port}`;
    const tokenPath = join(dataDirectory, "api-token");
    let token;
    const request = async (path, { authenticated = true, ...optionsForRequest } = {}) => fetch(`${endpoint}${path}`, {
      ...optionsForRequest,
      headers: { ...(authenticated ? { "x-local-dev-token": token } : {}), ...optionsForRequest.headers },
      signal: AbortSignal.timeout(5_000),
    });
    const rpc = (chat, name, args) => ({ jsonrpc: "2.0", id: ++nextId, method: "tools/call", params: {
      name, arguments: args, ...(chat === null ? {} : { _meta: { "openai/session": chat } }),
    } });
    async function bridge(messages) {
      check(!interrupted, "The check was interrupted.");
      const initializeId = ++nextId;
      const input = new PassThrough();
      const output = new PassThrough();
      const repliesPromise = (async () => {
        let wire = "";
        for await (const chunk of output) wire += chunk.toString("utf8");
        return wire.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      })();
      const running = startBridge({ input, output, tokenPath, endpoint: `${endpoint}/mcp`, requestTimeoutMs: 5_000 });
      input.end([
        { jsonrpc: "2.0", id: initializeId, method: "initialize", params: {
          protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "local-dev-fresh-install-check", version: "1" },
        } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        ...messages,
      ].map((message) => JSON.stringify(message)).join("\n") + "\n");
      await running;
      const replies = await repliesPromise;
      const initialized = replies.find((reply) => reply.id === initializeId);
      check(initialized?.result && !initialized.error, "Packaged MCP initialization failed.");
      return messages.map((message) => {
        const reply = replies.find((item) => item.id === message.id);
        check(reply, "The packaged bridge did not return a requested result.");
        return reply;
      });
    }
    function success(reply) {
      check(!reply.error && reply.result && reply.result.isError !== true, "A scoped tool was unexpectedly refused.");
      const text = reply.result.content?.find((item) => item.type === "text")?.text;
      check(typeof text === "string", "A tool did not return its expected JSON text.");
      return JSON.parse(text);
    }
    function denied(reply) {
      check(reply.error || reply.result?.isError === true, "A request that required access was unexpectedly allowed.");
    }
    async function tool(chat, name, args) { return (await bridge([rpc(chat, name, args)]))[0]; }
    async function startService() {
      stopPromise = undefined;
      service = spawn(node, [daemon], {
        env: { ...process.env, LOCAL_DEV_DATA_DIR: dataDirectory, LOCAL_DEV_PORT: String(port),
          LOCAL_DEV_CHAT_FOLDERS_DATABASE: join(dataDirectory, "chat-folders.sqlite"), LOCAL_DEV_PARENT_PID: undefined },
        stdio: ["ignore", "ignore", "pipe"],
      });
      // Drain diagnostics without printing tool payloads, local paths, or credentials.
      service.stderr.on("data", () => {});
      let spawnError = false;
      service.once("error", () => { spawnError = true; });
      serviceExit = new Promise((resolveExit) => service.once("close", resolveExit));
      for (let attempt = 0; attempt < 100; attempt += 1) {
        check(!interrupted && !spawnError && service.exitCode === null && service.signalCode === null,
          "The disposable packaged service stopped before it was ready.");
        try {
          const health = await request("/health", { authenticated: false });
          if (health.ok) {
            const status = await health.json();
            const savedToken = (await readFile(tokenPath, "utf8")).trim();
            if (/^[a-f0-9]{64}$/.test(savedToken)) { token = savedToken; version = status.version; return; }
          }
        } catch { /* Wait only for this disposable service. */ }
        await pause(50);
      }
      throw new Error("The disposable packaged service did not become ready.");
    }
    await step("empty local state starts", async () => {
      await startService();
      const status = await request("/v1/status");
      check(status.ok, "Service status was unavailable.");
      check((await status.json()).chats.length === 0, "The disposable service inherited another installation's chats.");
    });
    await step("control API and MCP require authentication", async () => {
      const results = await Promise.all([
        request("/v1/status", { authenticated: false }),
        request("/mcp", { authenticated: false, method: "POST" }),
      ]);
      check(results.every((response) => response.status === 401), "An endpoint accepted an unauthenticated request.");
    });
    await step("exactly the retained tools are advertised", async () => {
      const [reply] = await bridge([{ jsonrpc: "2.0", id: ++nextId, method: "tools/list" }]);
      const advertised = reply.result?.tools?.map((item) => item.name).sort();
      check(!reply.error && advertised?.length === 15, "The packaged tool count was not 15.");
      check(JSON.stringify(advertised) === JSON.stringify(expectedTools), "The package advertised unexpected tools.");
    });
    await step("missing per-chat identity is refused", async () => {
      denied(await tool(null, "local_dev_project_setup", {}));
    });
    const chatA = "local-dev-fresh-install-chat-a";
    const chatB = "local-dev-fresh-install-chat-b";
    let first;
    let second;
    await step("two chats await manual folder selection", async () => {
      const replies = await bridge([
        rpc(chatA, "local_dev_project_setup", { title: "Fresh install first chat" }),
        rpc(chatB, "local_dev_project_setup", { title: "Fresh install second chat" }),
      ]);
      const a = success(replies[0]); const b = success(replies[1]);
      check(a.connected === false && b.connected === false, "A chat received an automatic folder grant.");
      first = a.chat; second = b.chat;
      check(first.id !== second.id && first.setupCode !== second.setupCode, "Chat discovery did not keep independent identities.");
      const blocked = await bridge([
        rpc(chatA, "local_dev_file_read", { path: "briefing.md" }),
        rpc(chatA, "local_dev_file_write", { path: "denied.txt", content: "not granted" }),
        rpc(chatA, "local_dev_skills", { action: "list" }),
      ]);
      blocked.forEach(denied);
    });
    async function selectFolder(chat) {
      const response = await request(`/v1/chats/${encodeURIComponent(chat.id)}/folder`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ folderPath: projectDirectory, expectedRevision: chat.revision }),
      });
      check(response.ok, "Manual folder selection was refused.");
      return (await response.json()).chat;
    }
    await step("manual selections allow the same folder for both chats", async () => {
      first = await selectFolder(first);
      second = await selectFolder(second);
      check(first.folderPath === canonicalProject && second.folderPath === canonicalProject,
        "Two separate chats could not select the same canonical folder.");
    });
    let guide;
    await step("each chat needs its own catalog check", async () => {
      for (const chat of [chatA, chatB]) denied(await tool(chat, "local_dev_file_write", { path: "denied.txt", content: "not reviewed" }));
      const catalog = success(await tool(chatA, "local_dev_skills", { action: "list", query: "local-demo" }));
      guide = catalog.skills.find((skill) => skill.name === "local-demo" && skill.source === "project");
      check(guide, "The bundled example's project skill was not discovered.");
      denied(await tool(chatB, "local_dev_file_write", { path: "denied.txt", content: "another chat checked" }));
    });
    await step("project skill is read through its opaque catalog ID", async () => {
      const result = success(await tool(chatA, "local_dev_skills", { action: "read", id: guide.id }));
      check(result.skill.name === "local-demo" && typeof result.content === "string" && result.content.includes("Read `briefing.md`"),
        "The selected project skill was not read.");
    });
    const marker = "LOCAL_DEV_FRESH_INSTALL_CANARY\n";
    const checkpoint = { goal: "Fresh install acceptance", completed: [], verification: [], nextStep: "Run scoped acceptance checks", status: "in_progress" };
    const saveCheckpoint = async chat => {
      success(await tool(chat, "local_dev_work_log", { action: "read" }));
      success(await tool(chat, "local_dev_work_log", { action: "checkpoint", checkpoint }));
    };
    await step("first change requires a saved recovery checkpoint", async () => {
      denied(await tool(chatA, "local_dev_file_write", { path: "denied.txt", content: "checkpoint missing" }));
      await saveCheckpoint(chatA);
    });
    await step("scoped write and shared-folder read agree", async () => {
      success(await tool(chatA, "local_dev_file_write", { path: "canary.txt", content: marker }));
      const result = success(await tool(chatB, "local_dev_file_read", { path: "canary.txt" }));
      check(result.content === marker, "Another connected chat could not read the exact shared canary.");
      check(await readFile(join(projectDirectory, "canary.txt"), "utf8") === marker, "The canary was not saved in the selected folder.");
    });
    await step("second chat can independently read skills and write", async () => {
      const catalog = success(await tool(chatB, "local_dev_skills", { action: "list", query: "local-demo" }));
      const ownGuide = catalog.skills.find((skill) => skill.name === "local-demo" && skill.source === "project");
      check(ownGuide, "The second chat could not discover its project skill.");
      success(await tool(chatB, "local_dev_skills", { action: "read", id: ownGuide.id }));
      await saveCheckpoint(chatB);
      success(await tool(chatB, "local_dev_file_write", { path: "second-canary.txt", content: marker }));
    });
    await step("bounded shell command runs in the selected folder", async () => {
      const result = success(await tool(chatB, "local_dev_shell", { command: "printf 'LOCAL_DEV_SHELL_OK\\n'", timeoutMs: 1_000 }));
      check(result.exitCode === 0 && result.stdout === "LOCAL_DEV_SHELL_OK\n", "The bounded shell smoke check failed.");
    });
    await step("disconnect revokes only the selected chat", async () => {
      const response = await request(`/v1/chats/${encodeURIComponent(first.id)}/disconnect`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: first.revision }),
      });
      check(response.ok && (await response.json()).chat.folderPath === null, "The first chat was not disconnected.");
      denied(await tool(chatA, "local_dev_file_read", { path: "canary.txt" }));
      denied(await tool(chatA, "local_dev_skills", { action: "list" }));
      success(await tool(chatB, "local_dev_file_write", { path: "second-canary.txt", content: marker }));
    });
    await step("folder connections survive service restart", async () => {
      await stopService();
      await startService();
      const a = success(await tool(chatA, "local_dev_project_setup", {}));
      const b = success(await tool(chatB, "local_dev_project_setup", {}));
      check(a.connected === false && b.connected === true && b.chat.folderPath === canonicalProject,
        "Restart did not preserve the independent connections.");
      check(b.chat.id === second.id && b.chat.revision === second.revision, "Restart changed the selected chat identity or revision.");
      check(success(await tool(chatB, "local_dev_file_read", { path: "canary.txt" })).content === marker,
        "The retained chat could not read its saved folder after restart.");
    });
    await step("restart requires a fresh skill check before changes", async () => {
      denied(await tool(chatB, "local_dev_file_write", { path: "after-restart.txt", content: marker }));
      const catalog = success(await tool(chatB, "local_dev_skills", { action: "list", query: "local-demo" }));
      const ownGuide = catalog.skills.find((skill) => skill.name === "local-demo" && skill.source === "project");
      check(ownGuide, "The project skill disappeared after restart.");
      success(await tool(chatB, "local_dev_skills", { action: "read", id: ownGuide.id }));
      denied(await tool(chatB, "local_dev_file_write", { path: "after-restart.txt", content: marker }));
      const log = success(await tool(chatB, "local_dev_work_log", { action: "read" }));
      check(log.checkpoint?.goal === checkpoint.goal && log.events.some(event => event.tool === "local_dev_shell" && event.status === "execution_recorded"), "Restart lost recovery history or the checkpoint.");
      await saveCheckpoint(chatB);
      success(await tool(chatB, "local_dev_file_write", { path: "after-restart.txt", content: marker }));
    });
    return { passed: true, version, checks: passed };
  } catch (error) {
    const failure = new Error(`Fresh install check failed during “${currentStep}”. ${error instanceof Error ? error.message : "Check failed."}`);
    failure.report = { passed: false, ...(version ? { version } : {}), checks: passed };
    throw failure;
  } finally {
    await stopService();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

async function saveReport(path, report) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}

try {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/fresh-install-check.mjs [--app 'dist/Chat2Local.app'] [--report result.json]\nTests the packaged service and bridge using disposable local state and a copy of the example folder.");
  } else {
    try {
      const report = await run(options);
      await saveReport(options.report, report);
      console.log(`Fresh install check passed (${report.checks.length} checks). No native UI or tunnel was launched.`);
    } catch (error) {
      await saveReport(options.report, error.report ?? { passed: false, checks: [] });
      throw error;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Fresh install check failed.");
  process.exitCode = 1;
}
