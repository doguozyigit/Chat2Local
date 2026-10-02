#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const DEFAULT_ENDPOINT = "http://127.0.0.1:43127/mcp";
const DEFAULT_TOKEN_PATH = join(homedir(), ".local-dev", "api-token");
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_CONCURRENT_CLIENT_MESSAGES = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

function validateEndpoint(endpoint) {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" ||
      !parsed.port || parsed.pathname !== "/mcp" || parsed.search || parsed.hash ||
      parsed.username || parsed.password) {
    throw new Error("Chat2Local MCP endpoint must be a local HTTP /mcp address");
  }
  return parsed.href;
}

function readToken(tokenPath) {
  let file;
  try {
    file = openSync(tokenPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 ||
        stat.size > 65 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("unsafe token file");
    }
    const token = readFileSync(file, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid token");
    return token;
  } catch {
    throw new Error("Start Chat2Local to make its protected MCP connection available.");
  } finally {
    if (file !== undefined) closeSync(file);
  }
}

async function* readBoundedChunks(response) {
  let bytes = 0;
  if (!response.body) return;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      throw new Error("Chat2Local MCP response exceeded the size limit");
    }
    yield chunk;
  }
}

async function readBounded(response) {
  const chunks = [];
  for await (const chunk of readBoundedChunks(response)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function readMessages(response, onMessage) {
  const contentType = response.headers.get("content-type") ?? "";
  if (response.status === 202 || !contentType.includes("text/event-stream")) {
    const body = await readBounded(response);
    if (response.status !== 202 && body.trim()) onMessage(JSON.parse(body));
    return;
  }
  const decoder = new TextDecoder();
  let pending = "";
  let data = [];
  const consumeLine = (line) => {
    if (line === "data") data.push("");
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    if (line === "" && data.length) {
      const joined = data.join("\n");
      data = [];
      if (joined && joined !== "[DONE]") onMessage(JSON.parse(joined));
    }
  };
  const consumeLines = (final = false) => {
    let start = 0;
    for (let index = 0; index < pending.length; index += 1) {
      const char = pending[index];
      if (char !== "\n" && char !== "\r") continue;
      // A CRLF pair can be split across separate network chunks.
      if (char === "\r" && index + 1 === pending.length && !final) break;
      consumeLine(pending.slice(start, index));
      if (char === "\r" && pending[index + 1] === "\n") index += 1;
      start = index + 1;
    }
    pending = pending.slice(start);
    if (final) {
      if (pending) consumeLine(pending);
      consumeLine("");
    }
  };
  for await (const chunk of readBoundedChunks(response)) {
    pending += decoder.decode(chunk, { stream: true });
    consumeLines();
  }
  pending += decoder.decode();
  consumeLines(true);
}

function errorReply(id, error) {
  const message = error instanceof Error ? error.message : "Chat2Local MCP connection failed";
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

function isCancellationNotification(message) {
  return message?.method === "notifications/cancelled" && !Object.hasOwn(message, "id");
}

export async function startBridge({
  input = process.stdin,
  output = process.stdout,
  tokenPath = DEFAULT_TOKEN_PATH,
  endpoint = DEFAULT_ENDPOINT,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const url = validateEndpoint(endpoint);
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 600_000) {
    throw new Error("Chat2Local MCP request timeout must be between 1 and 600000 ms");
  }
  let sessionId;
  let initializeLine;
  let protocolVersion = "2025-06-18";
  const lines = createInterface({ input, crlfDelay: Infinity });
  const reply = (value) => output.write(`${JSON.stringify(value)}\n`);
  const sendLine = async (payload) => {
    const token = readToken(tokenPath);
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": protocolVersion,
      "x-local-dev-token": token,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    return fetch(url, {
      method: "POST",
      headers,
      body: payload,
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  };
  const ensureSuccess = (response) => {
    if (!response.ok) {
      throw new Error(response.status === 401 || response.status === 403
        ? "Chat2Local MCP authentication failed. Restart Chat2Local and reconnect the plugin."
        : `Chat2Local MCP returned HTTP ${response.status}`);
    }
  };

  const processMessage = async (line, request) => {
    const hasMethod = typeof request?.method === "string";
    const isCancellation = isCancellationNotification(request);
    const expectsReply = hasMethod && Object.hasOwn(request, "id");
    let replied = false;
    try {
      if (request?.method === "initialize" &&
          typeof request.params?.protocolVersion === "string") {
        protocolVersion = request.params.protocolVersion;
        initializeLine = line;
        sessionId = undefined;
      }
      let response = await sendLine(line);
      // Client results and cancellations belong to the original request/session.
      // Never replay them into a new session after the daemon restarts.
      if (response.status === 404 && hasMethod && !isCancellation && sessionId && initializeLine && request.method !== "initialize") {
        await response.body?.cancel();
        sessionId = undefined;
        const init = await sendLine(initializeLine);
        ensureSuccess(init);
        let initResult;
        const initId = JSON.parse(initializeLine).id;
        await readMessages(init, (message) => {
          if (message?.id === initId && !message.method) initResult = message.result;
        });
        if (!initResult) throw new Error("Chat2Local MCP reinitialization failed");
        sessionId = init.headers.get("mcp-session-id") ?? undefined;
        const notification = await sendLine(JSON.stringify({
          jsonrpc: "2.0", method: "notifications/initialized",
        }));
        ensureSuccess(notification);
        await readBounded(notification);
        response = await sendLine(line);
      }
      ensureSuccess(response);
      const newSession = hasMethod && !isCancellation && response.headers.get("mcp-session-id");
      if (newSession) sessionId = newSession;
      if (!hasMethod || isCancellation) {
        await readBounded(response);
        return;
      }
      await readMessages(response, (message) => {
        if (expectsReply && message?.id === request.id && !message.method &&
            (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) replied = true;
        reply(message);
      });
    } catch (error) {
      if (expectsReply && !replied) reply(errorReply(request.id, error));
    }
  };
  let requestQueue = Promise.resolve();
  const clientMessages = new Set();
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON-RPC input" } });
        continue;
      }
      if (typeof request?.method === "string" && !isCancellationNotification(request)) {
        // Preserve initialization and tool ordering, without blocking stdin:
        // an active tool can await an elicitation response or cancellation.
        requestQueue = requestQueue.then(() => processMessage(line, request));
      } else {
        // Apply stdin backpressure instead of opening unbounded concurrent posts
        // or dropping client results/cancellations when the daemon is slow.
        while (clientMessages.size >= MAX_CONCURRENT_CLIENT_MESSAGES) {
          await Promise.race(clientMessages);
        }
        const pending = processMessage(line, request);
        clientMessages.add(pending);
        pending.finally(() => clientMessages.delete(pending));
      }
    }
  } finally {
    await requestQueue;
    await Promise.all(clientMessages);
    output.end();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startBridge().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Chat2Local MCP bridge failed"}\n`);
    process.exitCode = 1;
  });
}
