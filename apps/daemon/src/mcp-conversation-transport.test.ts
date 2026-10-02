import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { acceptedContent, inputRequired, McpServer, type McpHttpHandler } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { createConversationMcpHandler } from "./mcp-conversation-transport.js";

function fixture(options: Parameters<typeof createConversationMcpHandler>[1] = {}) {
  let creations = 0;
  let cancelled = false;
  const handler = createConversationMcpHandler(() => {
    creations += 1;
    const server = new McpServer({ name: "conversation-test", version: "1" }, {
      inputRequired: { maxRounds: 2, roundTimeoutMs: 1_000 },
    });
    server.registerTool("status", { inputSchema: z.object({}) }, async (_input, ctx) => ({
      content: [{ type: "text", text: JSON.stringify({
        capabilities: server.server.getClientCapabilities() ?? null,
        hasSession: Boolean(ctx.sessionId),
      }) }],
    }));
    server.registerTool("choose", { inputSchema: z.object({}) }, async (_input, ctx) => {
      const response = ctx.mcpReq.inputResponses?.choice;
      if (response) return { content: [{ type: "text", text: JSON.stringify({
        response, accepted: acceptedContent(ctx.mcpReq.inputResponses, "choice"),
      }) }] };
      return inputRequired({ inputRequests: { choice: inputRequired.elicit({
        message: "Where should this project live?",
        requestedSchema: { type: "object", properties: {
          destination: { type: "string", enum: ["local", "chat"] },
        }, required: ["destination"] },
      }) } });
    });
    server.registerTool("wait", { inputSchema: z.object({}) }, async (_input, ctx) => {
      await new Promise<void>((resolve) => {
        ctx.mcpReq.signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true });
      });
      return { content: [{ type: "text", text: "Stopped" }] };
    });
    return server;
  }, { keepAliveMs: 0, ...options });
  return { handler, creations: () => creations, cancelled: () => cancelled };
}

function request(body?: unknown, sessionId?: string, method = "POST") {
  return new Request("http://localhost/mcp", {
    method,
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function rpc(method: string, params: unknown = {}, id: number = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

async function initialize(handler: McpHttpHandler, options?: Parameters<McpHttpHandler["fetch"]>[1]) {
  const response = await handler.fetch(request(rpc("initialize", {
    protocolVersion: "2025-11-25", capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test-client", version: "1" },
  })), options);
  assert.equal(response.status, 200);
  const sessionId = response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  assert.ok((await response.text()).includes('"protocolVersion":"2025-11-25"'));
  return sessionId;
}

function readerFor(response: Response) {
  assert.ok(response.body);
  const reader = response.body.getReader();
  let buffered = "";
  return {
    reader,
    async next(): Promise<any> {
      while (true) {
        const boundary = buffered.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const line = frame.split("\n").find((part) => part.startsWith("data: "));
          if (line) return JSON.parse(line.slice(6));
          continue;
        }
        const chunk = await reader.read();
        assert.equal(chunk.done, false, "The stream ended before the expected message");
        buffered += new TextDecoder().decode(chunk.value);
      }
    },
  };
}

test("direct legacy calls remain stateless and do not invent client capabilities", async (t) => {
  const { handler } = fixture();
  t.after(() => handler.close());
  const response = await handler.fetch(request(rpc("tools/call", { name: "status", arguments: {} })));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("mcp-session-id"), null);
  const message = await readerFor(response).next();
  assert.deepEqual(JSON.parse(message.result.content[0].text), { capabilities: null, hasSession: false });
});

for (const action of ["accept", "decline", "cancel"] as const) {
  test(`initialized legacy session carries a real elicitation ${action} round trip`, async (t) => {
    const { handler, creations } = fixture();
    t.after(() => handler.close());
    const sessionId = await initialize(handler);
    const response = await handler.fetch(request(rpc("tools/call", { name: "choose", arguments: {} }, 9), sessionId));
    const stream = readerFor(response);
    const prompt = await stream.next();
    assert.equal(prompt.method, "elicitation/create");
    assert.deepEqual(prompt.params.requestedSchema.properties.destination.enum, ["local", "chat"]);
    const reply = { action, ...(action === "accept" ? { content: { destination: "local" } } : {}) };
    const posted = await handler.fetch(request({ jsonrpc: "2.0", id: prompt.id, result: reply }, sessionId));
    assert.equal(posted.status, 202);
    const final = await stream.next();
    assert.equal(final.id, 9);
    const data = JSON.parse(final.result.content[0].text);
    assert.deepEqual(data.response, reply);
    assert.equal(data.accepted?.destination, action === "accept" ? "local" : undefined);
    assert.equal(creations(), 1, "Reply POST must reuse the initialized server");
  });
}

test("unknown or deleted session IDs cannot silently become stateless calls", async (t) => {
  const { handler } = fixture();
  t.after(() => handler.close());
  const sessionId = await initialize(handler);
  assert.equal((await handler.fetch(request(undefined, sessionId, "DELETE"))).status, 200);
  for (const id of [sessionId, "unknown"]) {
    assert.equal((await handler.fetch(request(rpc("tools/call", { name: "status", arguments: {} }), id))).status, 404);
  }
});

test("session count is bounded and expiry frees a slot", async (t) => {
  // Exercise TTL transitions deliberately. A 25 ms wall-clock TTL can expire
  // during initialization when the full suite runs alongside a release build.
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const { handler } = fixture({ maxSessions: 1, sessionIdleTtlMs: 25, sweepIntervalMs: 10 });
  t.after(() => handler.close());
  const oldId = await initialize(handler);
  const full = await handler.fetch(request(rpc("initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
  })));
  assert.equal(full.status, 503);
  t.mock.timers.tick(60);
  assert.notEqual(await initialize(handler), oldId);
  assert.equal((await handler.fetch(request(undefined, oldId, "GET"))).status, 404);
});

test("verified authentication is tied to its initialized transport", async (t) => {
  const { handler } = fixture();
  t.after(() => handler.close());
  const owner = { authInfo: { token: "test-owner", clientId: "client", scopes: [] } };
  const stranger = { authInfo: { token: "different-owner", clientId: "client", scopes: [] } };
  const sessionId = await initialize(handler, owner);
  const status = () => request(rpc("tools/call", { name: "status", arguments: {} }), sessionId);
  assert.equal((await handler.fetch(status(), stranger)).status, 404);
  assert.equal((await handler.fetch(status())).status, 404);
  const response = await handler.fetch(status(), owner);
  assert.equal(response.status, 200);
  const message = await readerFor(response).next();
  assert.equal(JSON.parse(message.result.content[0].text).hasSession, true);
});

test("closing the handler closes pending elicitation streams and rejects reuse", async () => {
  const { handler } = fixture();
  const sessionId = await initialize(handler);
  const response = await handler.fetch(request(rpc("tools/call", { name: "choose", arguments: {} }), sessionId));
  const stream = readerFor(response);
  assert.equal((await stream.next()).method, "elicitation/create");
  await handler.close();
  assert.equal((await stream.reader.read()).done, true);
  await assert.rejects(handler.fetch(request(rpc("ping"), sessionId)), /closed/);
});

test("MCP cancellation reaches the original request without closing the session", async (t) => {
  const { handler, cancelled } = fixture();
  t.after(() => handler.close());
  const sessionId = await initialize(handler);
  const response = await handler.fetch(request(rpc("tools/call", { name: "wait", arguments: {} }, 55), sessionId));
  assert.equal(response.status, 200);
  const notified = await handler.fetch(request({ jsonrpc: "2.0", method: "notifications/cancelled",
    params: { requestId: 55, reason: "User cancelled" } }, sessionId));
  assert.equal(notified.status, 202);
  await delay(0);
  assert.equal(cancelled(), true);
  await response.body?.cancel();
  const status = await handler.fetch(request(rpc("tools/call", { name: "status", arguments: {} }, 56), sessionId));
  assert.equal((await readerFor(status).next()).id, 56);
});

test("initializations under construction count against capacity and close safely", async () => {
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let productClosed = false;
  const handler = createConversationMcpHandler(async () => {
    started();
    await gate;
    const server = new McpServer({ name: "delayed", version: "1" });
    const originalClose = server.close.bind(server);
    server.close = async () => { productClosed = true; await originalClose(); };
    return server;
  }, { maxSessions: 1 });
  const init = () => request(rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {},
    clientInfo: { name: "test", version: "1" } }));
  const pending = handler.fetch(init());
  await began;
  assert.equal((await handler.fetch(init())).status, 503);
  await handler.close();
  release();
  assert.equal((await pending).status, 503);
  assert.equal(productClosed, true);
});

test("modern input-required requests keep the SDK protocol path", async (t) => {
  const { handler } = fixture();
  t.after(() => handler.close());
  const response = await handler.fetch(new Request("http://localhost/mcp", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-method": "tools/call", "mcp-name": "choose", "mcp-protocol-version": "2026-07-28" },
    body: JSON.stringify(rpc("tools/call", {
      name: "choose", arguments: {}, _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "modern-test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
      },
    })),
  }));
  const message = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(message));
  assert.equal(message.result.resultType, "input_required");
  assert.equal(message.result.inputRequests.choice.method, "elicitation/create");
  assert.equal(response.headers.get("mcp-session-id"), null);
});
