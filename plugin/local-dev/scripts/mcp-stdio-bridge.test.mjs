import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startBridge } from "./mcp-stdio-bridge.mjs";

const token = "a".repeat(64);
const daemonPath = process.env.LOCAL_DEV_BRIDGE_TEST_DAEMON_PATH ??
  fileURLToPath(new URL("../../../apps/daemon/dist/index.js", import.meta.url));

async function collect(stream) {
  let value = "";
  for await (const chunk of stream) value += chunk.toString("utf8");
  return value.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("stdio bridge forwards authenticated MCP requests and preserves session identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-dev-mcp-bridge-"));
  const tokenPath = join(directory, "api-token");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString("utf8");
    requests.push({ headers: request.headers, body: JSON.parse(body) });
    if (requests.length === 1) {
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "session-from-daemon",
      });
      response.end(JSON.stringify({
        jsonrpc: "2.0", id: 1,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } },
      }));
    } else if (requests.length === 2) {
      response.writeHead(202);
      response.end();
    } else {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("event: message\ndata: " + JSON.stringify({
        jsonrpc: "2.0", id: 2,
        result: { content: [{ type: "text", text: "skill list" }] },
      }) + "\n\n");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const input = new PassThrough();
  const output = new PassThrough();
  const outputPromise = collect(output);
  try {
    const running = startBridge({
      input, output, tokenPath,
      endpoint: `http://127.0.0.1:${address.port}/mcp`,
    });
    input.end([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "local_dev_skills", arguments: { action: "list" }, _meta: { "openai/session": "chat-a" } } }),
    ].join("\n") + "\n");
    await running;
    const replies = await outputPromise;
    assert.deepEqual(replies.map((item) => item.id), [1, 2]);
    assert.equal(replies[1].result.content[0].text, "skill list");
    assert.equal(requests.length, 3);
    assert.ok(requests.every((item) => item.headers["x-local-dev-token"] === token));
    assert.equal(requests[0].headers.host, `127.0.0.1:${address.port}`);
    assert.equal(requests[0].headers.origin, undefined);
    assert.equal(requests[1].headers["mcp-session-id"], "session-from-daemon");
    assert.equal(requests[2].headers["mcp-session-id"], "session-from-daemon");
    assert.equal(requests[2].body.params._meta["openai/session"], "chat-a");
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stdio bridge refuses a missing token before contacting the daemon", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputPromise = collect(output);
  const running = startBridge({
    input, output,
    tokenPath: join(tmpdir(), "nonexistent-local-dev-api-token"),
    endpoint: "http://127.0.0.1:43127/mcp",
  });
  input.end(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) + "\n");
  await running;
  const replies = await outputPromise;
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, 9);
  assert.match(replies[0].error.message, /Start Chat2Local/i);
});

test("stdio bridge refuses a token file readable by other users", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-dev-mcp-bridge-"));
  const tokenPath = join(directory, "api-token");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o644 });
  const input = new PassThrough();
  const output = new PassThrough();
  const outputPromise = collect(output);
  try {
    const running = startBridge({ input, output, tokenPath });
    input.end(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }) + "\n");
    await running;
    const replies = await outputPromise;
    assert.match(replies[0].error.message, /Start Chat2Local/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stdio bridge refuses non-loopback endpoints before sending a token", async () => {
  await assert.rejects(
    startBridge({ endpoint: "https://example.com/mcp" }),
    /local HTTP \/mcp address/,
  );
});

test("stdio bridge bounds a stalled daemon request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-dev-mcp-bridge-"));
  const tokenPath = join(directory, "api-token");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const input = new PassThrough();
  const output = new PassThrough();
  const outputPromise = collect(output);
  try {
    const running = startBridge({ input, output, tokenPath,
      endpoint: `http://127.0.0.1:${address.port}/mcp`, requestTimeoutMs: 50 });
    input.end(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }) + "\n");
    await running;
    const replies = await outputPromise;
    assert.equal(replies[0].id, 5);
    assert.ok(replies[0].error);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stdio bridge reinitializes once after a stale daemon session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-dev-mcp-bridge-"));
  const tokenPath = join(directory, "api-token");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString("utf8");
    const message = JSON.parse(body);
    requests.push({ message, session: request.headers["mcp-session-id"] });
    if (requests.length === 1 || requests.length === 3) {
      const session = requests.length === 1 ? "old-session" : "new-session";
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": session });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } } }));
    } else if (requests.length === 2) {
      response.writeHead(404); response.end();
    } else if (requests.length === 4) {
      response.writeHead(202); response.end();
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const input = new PassThrough();
  const output = new PassThrough();
  const outputPromise = collect(output);
  try {
    const running = startBridge({ input, output, tokenPath,
      endpoint: `http://127.0.0.1:${address.port}/mcp` });
    input.end([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ].join("\n") + "\n");
    await running;
    const replies = await outputPromise;
    assert.deepEqual(replies.map((item) => item.id), [1, 2]);
    assert.equal(requests.length, 5);
    assert.deepEqual(requests.map((item) => item.message.method), [
      "initialize", "tools/list", "initialize", "notifications/initialized", "tools/list",
    ]);
    assert.equal(requests[1].session, "old-session");
    assert.equal(requests[4].session, "new-session");
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("packaged service and bridge connect two chats manually to the same folder", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-dev-mcp-e2e-"));
  const project = join(directory, "project");
  const skillDirectory = join(project, "skills", "smoke-guide");
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(join(skillDirectory, "SKILL.md"),
    "---\nname: smoke-guide\ndescription: Bridge integration check\n---\nUse the exact selected guide.\n");
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve) => probe.close(resolve));
  const port = address.port;
  const endpoint = `http://127.0.0.1:${port}`;
  const tokenPath = join(directory, "api-token");
  const daemon = spawn(process.execPath, [daemonPath], {
    env: { ...process.env, LOCAL_DEV_DATA_DIR: directory, LOCAL_DEV_PORT: String(port),
      LOCAL_DEV_PARENT_PID: undefined },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let daemonError = "";
  daemon.stderr.on("data", (chunk) => { daemonError += chunk.toString("utf8"); });
  const initialize = (id) => ({ jsonrpc: "2.0", id, method: "initialize", params: {
    protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: "folder-bridge-test", version: "1" },
  } });
  const tool = (id, chat, name, args) => ({ jsonrpc: "2.0", id,
    method: "tools/call", params: { name, arguments: args,
      _meta: { "openai/session": chat } } });
  const callBridge = async (messages) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const replies = collect(output);
    const running = startBridge({ input, output, tokenPath, endpoint: `${endpoint}/mcp` });
    input.end(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
    await running;
    return replies;
  };
  const textResult = (replies, id) => {
    const reply = replies.find((message) => message.id === id);
    assert.ok(reply?.result, `Missing result ${id}: ${JSON.stringify(reply)}`);
    assert.equal(reply.result.isError, undefined, JSON.stringify(reply.result));
    return JSON.parse(reply.result.content[0].text);
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (daemon.exitCode !== null) break;
      try {
        const health = await fetch(`${endpoint}/health`);
        if (health.ok) { ready = true; break; }
      } catch { /* The disposable service is starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, `Service did not start: ${daemonError}`);
    const unauthorized = await fetch(`${endpoint}/mcp`, { method: "POST" });
    assert.equal(unauthorized.status, 401);

    const discovered = await callBridge([
      initialize(1), { jsonrpc: "2.0", method: "notifications/initialized" },
      tool(2, "bridge-chat-a", "local_dev_project_setup", { title: "First chat" }),
      tool(3, "bridge-chat-b", "local_dev_project_setup", { title: "Second chat" }),
      tool(4, "bridge-chat-a", "local_dev_file_write", { path: "blocked.txt", content: "denied" }),
    ]);
    const chatA = textResult(discovered, 2);
    const chatB = textResult(discovered, 3);
    assert.equal(chatA.connected, false);
    assert.equal(chatB.connected, false);
    assert.notEqual(chatA.chat.id, chatB.chat.id);
    assert.notEqual(chatA.chat.setupCode, chatB.chat.setupCode);
    assert.equal(discovered.find((message) => message.id === 4).result.isError, true);

    const nativePut = async (chat) => {
      const response = await fetch(`${endpoint}/v1/chats/${encodeURIComponent(chat.id)}/folder`, {
        method: "PUT",
        headers: { "content-type": "application/json",
          "x-local-dev-token": readFileSync(tokenPath, "utf8").trim() },
        body: JSON.stringify({ folderPath: project, expectedRevision: chat.revision }),
      });
      assert.equal(response.status, 200, await response.text().then((value) => value));
    };
    await nativePut(chatA.chat);
    await nativePut(chatB.chat);

    const connected = await callBridge([
      initialize(5), { jsonrpc: "2.0", method: "notifications/initialized" },
      tool(6, "bridge-chat-a", "local_dev_project_setup", {}),
      tool(7, "bridge-chat-b", "local_dev_project_setup", {}),
      tool(8, "bridge-chat-a", "local_dev_skills", { action: "list", query: "smoke-guide" }),
      tool(20, "bridge-chat-a", "local_dev_work_log", { action: "read" }),
      tool(21, "bridge-chat-a", "local_dev_work_log", { action: "checkpoint", checkpoint: { goal: "Bridge fixture", completed: [], verification: [], nextStep: "Write shared canary", status: "in_progress" } }),
      tool(9, "bridge-chat-a", "local_dev_file_write", { path: "shared.txt", content: "same folder, separate chats\n" }),
      tool(10, "bridge-chat-b", "local_dev_file_read", { path: "shared.txt" }),
      tool(11, "bridge-chat-b", "local_dev_file_write", { path: "no-skill-check.txt", content: "denied" }),
      { jsonrpc: "2.0", id: 12, method: "tools/list" },
    ]);
    assert.equal(textResult(connected, 6).connected, true);
    assert.equal(textResult(connected, 7).connected, true);
    const listed = textResult(connected, 8);
    assert.equal(listed.skills[0].name, "smoke-guide");
    const guideReplies = await callBridge([
      initialize(13), { jsonrpc: "2.0", method: "notifications/initialized" },
      tool(14, "bridge-chat-a", "local_dev_skills", { action: "read", id: listed.skills[0].id }),
    ]);
    assert.match(JSON.stringify(textResult(guideReplies, 14)), /Use the exact selected guide/);
    assert.equal(connected.find((message) => message.id === 9).result.isError, undefined);
    assert.equal(readFileSync(join(project, "shared.txt"), "utf8"), "same folder, separate chats\n");
    const read = connected.find((message) => message.id === 10);
    assert.equal(read.result.isError, undefined);
    assert.match(read.result.content[0].text, /same folder, separate chats/);
    assert.equal(connected.find((message) => message.id === 11).result.isError, true,
      "One chat's skill check must not authorize another chat's write");
    const tools = connected.find((message) => message.id === 12).result.tools.map((item) => item.name);
    assert.ok(tools.includes("local_dev_file_write"));
    assert.ok(tools.includes("local_dev_skills"));
    assert.ok(tools.every((name) => !/worker|primary|continuation|checkpoint|team_|desktop_bind/.test(name)));
  } finally {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill("SIGTERM");
      await new Promise((resolve) => daemon.once("exit", resolve));
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stdio bridge streams elicitation and accepts its response before the tool stream closes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-dev-mcp-elicitation-"));
  const tokenPath = join(directory, "api-token");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  const requests = [];
  let toolResponse;
  const elicitation = { jsonrpc: "2.0", id: "choose-folder", method: "elicitation/create",
    params: { mode: "form", message: "Where should café live?", requestedSchema: {
      type: "object", properties: { destination: { type: "string", enum: ["local", "chat"] } },
      required: ["destination"],
    } } };
  const clientResult = { jsonrpc: "2.0", id: elicitation.id,
    result: { action: "accept", content: { destination: "local" } } };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString("utf8");
    const message = JSON.parse(body);
    requests.push({ message, headers: request.headers });
    if (message.method === "initialize") {
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "choice-session" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } } }));
    } else if (message.method === "tools/call") {
      toolResponse = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const frame = Buffer.from(": keepalive\r\nevent: message\r\ndata: " + JSON.stringify(elicitation) + "\r\n\r\n");
      const split = frame.indexOf(Buffer.from("é")) + 1;
      response.write(frame.subarray(0, split));
      setImmediate(() => {
        response.write(frame.subarray(split, frame.length - 1));
        setImmediate(() => response.write(frame.subarray(frame.length - 1)));
      });
    } else {
      response.writeHead(202);
      response.end();
      if (message.id === elicitation.id) {
        toolResponse.end("event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: 2,
          result: { content: [{ type: "text", text: "choice received" }] } }) + "\n\n");
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const input = new PassThrough();
  const output = new PassThrough();
  let partial = "";
  const replies = [];
  output.on("data", (chunk) => {
    partial += chunk.toString("utf8");
    let newline;
    while ((newline = partial.indexOf("\n")) >= 0) {
      const message = JSON.parse(partial.slice(0, newline));
      partial = partial.slice(newline + 1);
      replies.push(message);
      if (message.method === "elicitation/create") input.write(JSON.stringify(clientResult) + "\n");
      if (message.id === 2 && !message.method) input.end();
    }
  });
  const watchdog = setTimeout(() => input.end(), 2_000);
  try {
    const running = startBridge({ input, output, tokenPath,
      endpoint: `http://127.0.0.1:${address.port}/mcp`, requestTimeoutMs: 1_000 });
    input.write([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18", capabilities: { elicitation: { form: {} } },
        clientInfo: { name: "choice-test", version: "1" },
      } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "choice" } }),
    ].join("\n") + "\n");
    await running;
    assert.deepEqual(replies.map((message) => message.id), [1, elicitation.id, 2]);
    assert.deepEqual(replies[1], elicitation);
    assert.equal(replies[2].result.content[0].text, "choice received");
    assert.deepEqual(requests.map(({ message }) => message.method ?? "response"),
      ["initialize", "notifications/initialized", "tools/call", "response"]);
    assert.deepEqual(requests[3].message, clientResult);
    assert.equal(requests[3].headers["mcp-session-id"], "choice-session");
    assert.ok(requests.every(({ headers }) => headers["x-local-dev-token"] === token));
  } finally {
    clearTimeout(watchdog);
    server.closeAllConnections();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stdio bridge never replies to JSON-RPC results, errors, or notifications on transport failure", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputPromise = collect(output);
  const running = startBridge({ input, output,
    tokenPath: join(tmpdir(), "nonexistent-local-dev-api-token"),
    endpoint: "http://127.0.0.1:43127/mcp" });
  input.end([
    { jsonrpc: "2.0", id: "choice-result", result: { action: "decline" } },
    { jsonrpc: "2.0", id: "choice-error", error: { code: -32603, message: "Client unavailable" } },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } },
  ].map((message) => JSON.stringify(message)).join("\n") + "\n");
  await running;
  assert.deepEqual(await outputPromise, []);
});

test("stdio bridge does not replay a stale-session elicitation response", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-dev-mcp-stale-response-"));
  const tokenPath = join(directory, "api-token");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  const input = new PassThrough();
  const output = new PassThrough();
  const outputPromise = collect(output);
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString("utf8");
    const message = JSON.parse(body);
    requests.push({ message, session: request.headers["mcp-session-id"] });
    if (message.method === "initialize") {
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "expired-session" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } } }));
    } else {
      response.writeHead(404);
      response.end();
      input.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  let wroteResult = false;
  output.on("data", () => {
    if (!wroteResult) {
      wroteResult = true;
      input.write(JSON.stringify({ jsonrpc: "2.0", id: "expired-choice", result: { action: "cancel" } }) + "\n");
    }
  });
  try {
    const running = startBridge({ input, output, tokenPath,
      endpoint: `http://127.0.0.1:${address.port}/mcp`, requestTimeoutMs: 1_000 });
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" },
    } }) + "\n");
    await running;
    assert.equal(requests.length, 2);
    assert.equal(requests[1].session, "expired-session");
    assert.equal(requests[1].message.result.action, "cancel");
    assert.deepEqual((await outputPromise).map((message) => message.id), [1]);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stdio bridge keeps timeout and cumulative size bounds while streaming SSE", async (t) => {
  for (const scenario of ["timeout", "size"]) {
    await t.test(scenario, async () => {
      const directory = mkdtempSync(join(tmpdir(), "local-dev-mcp-stream-bound-"));
      const tokenPath = join(directory, "api-token");
      writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: " + JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress",
          params: { progressToken: "bounded", progress: 1 } }) + "\n\n");
        if (scenario === "size") {
          // The limit includes comments, even when every individual frame is small.
          const comment = ":" + "x".repeat(1024 * 1024 - 3) + "\n\n";
          for (let index = 0; index < 32; index += 1) response.write(comment);
          response.end();
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const input = new PassThrough();
      const output = new PassThrough();
      const outputPromise = collect(output);
      try {
        const running = startBridge({ input, output, tokenPath,
          endpoint: `http://127.0.0.1:${address.port}/mcp`,
          requestTimeoutMs: scenario === "timeout" ? 100 : 5_000 });
        input.end(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "bounded" } }) + "\n");
        await running;
        const replies = await outputPromise;
        assert.equal(replies.length, 2);
        assert.equal(replies[0].method, "notifications/progress");
        assert.equal(replies[1].id, 8);
        assert.ok(replies[1].error);
        if (scenario === "size") assert.match(replies[1].error.message, /size limit/);
      } finally {
        server.closeAllConnections();
        server.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test("stdio bridge delivers cancellation before the outstanding tool stream closes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-dev-mcp-cancel-"));
  const tokenPath = join(directory, "api-token");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  const requests = [];
  let toolResponse;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString("utf8");
    const message = JSON.parse(body);
    requests.push({ message, session: request.headers["mcp-session-id"] });
    if (message.method === "initialize") {
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "cancel-session" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } } }));
    } else if (message.method === "tools/call") {
      toolResponse = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: " + JSON.stringify({ jsonrpc: "2.0", id: "cancel-choice", method: "elicitation/create",
        params: { mode: "form", message: "Choose a destination", requestedSchema: { type: "object", properties: {} } } }) + "\n\n");
    } else {
      // A cancelled session may already have expired. Do not reinitialize or replay.
      response.writeHead(404);
      response.end();
      toolResponse.end("data: " + JSON.stringify({ jsonrpc: "2.0", id: 2,
        result: { content: [{ type: "text", text: "cancelled" }] } }) + "\n\n");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const input = new PassThrough();
  const output = new PassThrough();
  const outputPromise = collect(output);
  let cancelled = false;
  let partial = "";
  output.on("data", (chunk) => {
    partial += chunk.toString("utf8");
    let newline;
    while ((newline = partial.indexOf("\n")) >= 0) {
      const message = JSON.parse(partial.slice(0, newline));
      partial = partial.slice(newline + 1);
      if (message.method === "elicitation/create" && !cancelled) {
        cancelled = true;
        input.end(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled",
          params: { requestId: 2, reason: "User cancelled" } }) + "\n");
      }
    }
  });
  const watchdog = setTimeout(() => input.end(), 2_000);
  try {
    const running = startBridge({ input, output, tokenPath,
      endpoint: `http://127.0.0.1:${address.port}/mcp`, requestTimeoutMs: 500 });
    input.write([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" },
      } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "choice" } },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n");
    await running;
    const replies = await outputPromise;
    assert.equal(replies[2]?.result?.content[0]?.text, "cancelled");
    assert.deepEqual(replies.map((message) => message.id), [1, "cancel-choice", 2]);
    assert.deepEqual(requests.map(({ message }) => message.method),
      ["initialize", "tools/call", "notifications/cancelled"]);
    assert.equal(requests[2].session, "cancel-session");
  } finally {
    clearTimeout(watchdog);
    server.closeAllConnections();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stdio bridge bounds concurrent client responses without dropping them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-dev-mcp-response-concurrency-"));
  const tokenPath = join(directory, "api-token");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  let active = 0;
  let maximumActive = 0;
  const received = [];
  const held = [];
  let releaseTimer;
  let released = false;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString("utf8");
    received.push(JSON.parse(body));
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const finish = () => {
      active -= 1;
      response.writeHead(202);
      response.end();
    };
    if (released) {
      finish();
    } else {
      held.push(finish);
      if (held.length === 32) releaseTimer = setTimeout(() => {
        released = true;
        for (const release of held) release();
      }, 200);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const input = new PassThrough();
  const output = new PassThrough();
  const outputPromise = collect(output);
  try {
    const running = startBridge({ input, output, tokenPath,
      endpoint: `http://127.0.0.1:${address.port}/mcp`, requestTimeoutMs: 2_000 });
    input.end(Array.from({ length: 50 }, (_, id) => JSON.stringify({ jsonrpc: "2.0", id,
      result: { action: "cancel" } })).join("\n") + "\n");
    await running;
    assert.equal(received.length, 50);
    assert.ok(maximumActive <= 32, `Expected at most 32 concurrent posts, received ${maximumActive}`);
    assert.ok(maximumActive > 1);
    assert.deepEqual(await outputPromise, []);
  } finally {
    clearTimeout(releaseTimer);
    server.closeAllConnections();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
