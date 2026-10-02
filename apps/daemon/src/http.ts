import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ChatFolderError, type ChatFolderStore } from "./chat-folder-store.js";
import type { TunnelManager } from "./tunnel-manager.js";
import { WorkLogError } from "./work-log-store.js";

interface HttpDependencies {
  host: string;
  port: number;
  version: string;
  startedAt: string;
  chats: ChatFolderStore;
  mcpHandler: McpHttpHandler;
  tunnel: TunnelManager;
  authToken: string;
  onFolderChanged?: (chatId: string, previousRevision: number) => Promise<void>;
}

export function createLocalHttpServer(deps: HttpDependencies) {
  const apiUrl = `http://${deps.host}:${deps.port}`;
  const mcpUrl = `${apiUrl}/mcp`;
  const chatSummaries = () => deps.chats.list().map(chat => ({ ...chat, recovery: deps.chats.workLog.summary({ chatId: chat.id, revision: chat.revision }) }));
  const mcpNodeHandler = toNodeHandler(deps.mcpHandler) as unknown as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  // Native tunnel controls cannot race configuration changes across a start/stop.
  let tunnelQueue = Promise.resolve();
  const tunnelOperation = <T>(operation: () => Promise<T>) => {
    const result = tunnelQueue.then(operation);
    tunnelQueue = result.then(() => {}, () => {});
    return result;
  };
  return createServer((req, res) => {
    void (async () => {
      let url: URL;
      try {
        const target = req.url ?? "/";
        if (!target.startsWith("/") || target.startsWith("//")) throw new Error();
        url = new URL(target, apiUrl);
        decodeURIComponent(url.pathname);
      } catch { sendJson(res, 400, { error: "invalid_request_target" }); return; }
      if (!isLocalRequest(req) || !hasLocalHostAndNoOrigin(req)) { sendJson(res, 403, { error: "forbidden" }); return; }
      if (url.pathname.startsWith("/v1/") || url.pathname === "/mcp") {
        const token = req.headers["x-local-dev-token"];
        if (typeof token !== "string" || !matchesToken(token, deps.authToken)) { sendJson(res, 401, { error: "unauthorized" }); return; }
      }
      if (url.pathname === "/mcp") { await mcpNodeHandler(req, res); return; }
      if (req.method === "GET" && url.pathname === "/health") { sendJson(res, 200, { ok: true, version: deps.version, startedAt: deps.startedAt }); return; }
      if (req.method === "GET" && url.pathname === "/") { sendJson(res, 200, { name: "Chat2Local", version: deps.version, mcp: mcpUrl }); return; }
      if (req.method === "GET" && url.pathname === "/v1/status") {
        sendJson(res, 200, { version: deps.version, startedAt: deps.startedAt, apiUrl, mcpUrl, chats: chatSummaries(), tunnel: deps.tunnel.status() }); return;
      }
      if (req.method === "GET" && url.pathname === "/v1/chats") { sendJson(res, 200, { chats: chatSummaries() }); return; }
      const recoveryRoute = url.pathname.match(/^\/v1\/chats\/([^/]+)\/work-log(?:\/(revisions|clear))?$/);
      if (recoveryRoute) {
        const id = decodeURIComponent(recoveryRoute[1]!);
        const chat = deps.chats.get(id);
        if (!chat) throw new ChatFolderError("unknown_chat", "This chat is unknown.");
        if (req.method === "GET" && recoveryRoute[2] === "revisions") {
          if ([...url.searchParams.keys()].length) throw new Error("Unexpected history query.");
          sendJson(res, 200, { revisions: deps.chats.workLog.revisions(id) }); return;
        }
        if (req.method === "GET" && !recoveryRoute[2]) {
          const query = z.object({ revision: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), beforeSequence: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).strict().parse(Object.fromEntries(url.searchParams));
          const revision = query.revision ?? chat.revision;
          if (revision !== chat.revision && !deps.chats.workLog.revisions(id).some(item => item.revision === revision)) throw new Error("Unknown folder history revision.");
          sendJson(res, 200, deps.chats.workLog.read({ chatId: id, revision }, { ...(query.limit === undefined ? {} : { limit: query.limit }), ...(query.beforeSequence === undefined ? {} : { beforeSequence: query.beforeSequence }) })); return;
        }
        if (req.method === "POST" && recoveryRoute[2] === "clear") {
          const input = z.object({ revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict().parse(await readJsonBody(req));
          const current = deps.chats.get(id);
          if (!current || input.expectedRevision !== current.revision) throw new ChatFolderError("revision_conflict", "This chat's folder changed. Refresh before clearing history.");
          if (input.revision !== current.revision && !deps.chats.workLog.revisions(id).some(item => item.revision === input.revision)) throw new Error("Unknown folder history revision.");
          sendJson(res, 200, { removed: deps.chats.workLog.clearCompleted({ chatId: id, revision: input.revision }) }); return;
        }
        sendJson(res, 405, { error: "method_not_allowed" }); return;
      }
      const folderRoute = url.pathname.match(/^\/v1\/chats\/([^/]+)\/(folder|disconnect)$/);
      if (folderRoute) {
        const id = decodeURIComponent(folderRoute[1]!);
        if (folderRoute[2] === "folder" && req.method === "PUT") {
          const input = z.object({ folderPath: z.string().min(1).max(4096), expectedRevision: z.number().int().nonnegative() }).strict().parse(await readJsonBody(req));
          const previous = deps.chats.get(id);
          const chat = await deps.chats.connect(id, input.folderPath, input.expectedRevision);
          if (previous?.revision !== chat.revision) await deps.onFolderChanged?.(id, previous?.revision ?? 0);
          sendJson(res, 200, { chat }); return;
        }
        if (folderRoute[2] === "disconnect" && req.method === "POST") {
          const input = z.object({ expectedRevision: z.number().int().nonnegative() }).strict().parse(await readJsonBody(req));
          const chat = deps.chats.disconnect(id, input.expectedRevision);
          await deps.onFolderChanged?.(id, input.expectedRevision);
          sendJson(res, 200, { chat }); return;
        }
        sendJson(res, 405, { error: "method_not_allowed" }); return;
      }
      if (req.method === "GET" && url.pathname === "/v1/tunnel") { sendJson(res, 200, deps.tunnel.status()); return; }
      if (req.method === "POST" && url.pathname === "/v1/tunnel/start") {
        const input = z.object({ tunnelId: z.string().min(1), runtimeKey: z.string().min(1), clientPath: z.string().optional(), adoptLegacy: z.boolean().optional() }).strict().parse(await readJsonBody(req));
        const status = await tunnelOperation(async () => {
          deps.tunnel.configure({ tunnelId: input.tunnelId, runtimeApiKey: input.runtimeKey, ...(input.clientPath ? { clientPath: input.clientPath } : {}) });
          return input.adoptLegacy ? deps.tunnel.adoptLegacyTunnel() : deps.tunnel.start();
        });
        sendJson(res, 200, status); return;
      }
      if (req.method === "POST" && url.pathname === "/v1/tunnel/stop") { sendJson(res, 200, await tunnelOperation(() => deps.tunnel.stop())); return; }
      sendJson(res, 404, { error: "not_found" });
    })().catch((error: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      const code = error instanceof ChatFolderError || error instanceof WorkLogError ? error.code : error instanceof Error ? error.message : "request_failed";
      const status = error instanceof ChatFolderError ? (error.code === "unknown_chat" ? 404 : error.code === "revision_conflict" || error.code === "chat_busy" ? 409 : 400)
        : error instanceof WorkLogError ? (error.code === "storage_full" || error.code === "store_closed" ? 503 : error.code === "operation_not_found" ? 404 : 400) : code === "request_body_too_large" ? 413 : 400;
      sendJson(res, status, { error: code, message: error instanceof Error ? error.message : "Request failed" });
    });
  });
}

function isLocalRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function hasLocalHostAndNoOrigin(req: IncomingMessage): boolean {
  return req.headers.host === `127.0.0.1:${req.socket.localPort}` && req.headers.origin === undefined;
}
function matchesToken(provided: string, expected: string): boolean {
  const actual = Buffer.from(provided); const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 16384) throw new Error("request_body_too_large");
    chunks.push(bytes);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}
