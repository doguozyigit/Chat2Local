import { createHash, randomUUID } from "node:crypto";
import {
  createMcpHandler,
  isInitializeRequest,
  isJsonContentType,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
  type CreateMcpHandlerOptions,
  type McpHandlerRequestOptions,
  type McpHttpHandler,
  type McpServerFactory,
} from "@modelcontextprotocol/server";

export interface ConversationMcpHandlerOptions extends Omit<CreateMcpHandlerOptions, "legacy"> {
  /** Includes initializations still being constructed. Existing sessions are never evicted for a new one. */
  maxSessions?: number;
  /** Idle transports expire, including abandoned human-input requests. */
  sessionIdleTtlMs?: number;
  sweepIntervalMs?: number;
}

type Session = {
  product: Awaited<ReturnType<McpServerFactory>>;
  transport: WebStandardStreamableHTTPServerTransport;
  authFingerprint: string;
  touchedAt: number;
};

function authFingerprint(auth?: AuthInfo): string {
  // The caller already authenticated the request. Do not retain credentials in
  // the registry or let a different verified credential reuse its transport.
  if (!auth) return "outer-authentication";
  return createHash("sha256").update(JSON.stringify([
    auth.token, auth.clientId, [...auth.scopes].sort(), auth.resource?.href ?? null,
  ])).digest("hex");
}

function errorResponse(status: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }, { status });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

/**
 * Keeps the existing direct-call/modern SDK paths, adding legacy sessions only
 * for clients that initialize. Those sessions let the SDK's inputRequired shim
 * receive elicitation replies. Session IDs identify transport connections only;
 * project/chat authorization must still use trusted host conversation metadata.
 * Authentication and Origin/Host checks remain in the outer HTTP handler.
 */
export function createConversationMcpHandler(
  factory: McpServerFactory,
  options: ConversationMcpHandlerOptions = {},
): McpHttpHandler {
  const { maxSessions: maxOption, sessionIdleTtlMs: ttlOption, sweepIntervalMs: sweepOption, ...sdkOptions } = options;
  const maxSessions = positiveInteger(maxOption ?? 64, "maxSessions");
  const sessionIdleTtlMs = positiveInteger(ttlOption ?? 30 * 60_000, "sessionIdleTtlMs");
  const sweepIntervalMs = positiveInteger(sweepOption ?? Math.min(sessionIdleTtlMs, 60_000), "sweepIntervalMs");
  const fallback = createMcpHandler(factory, sdkOptions);
  const sessions = new Map<string, Session>();
  const products = new Set<Session>();
  let constructing = 0;
  let closed = false;

  const report = (error: unknown) => {
    try { options.onerror?.(error instanceof Error ? error : new Error("MCP session failed")); } catch { /* Reporting must not break cleanup. */ }
  };
  const forget = (entry: Session) => {
    if (entry.transport.sessionId) sessions.delete(entry.transport.sessionId);
    products.delete(entry);
  };
  const dispose = async (entry: Session) => {
    forget(entry);
    await entry.product.close().catch(report);
  };
  const sweep = async () => {
    const cutoff = Date.now() - sessionIdleTtlMs;
    await Promise.all([...products].filter((entry) => entry.touchedAt <= cutoff).map(dispose));
  };
  const timer = setInterval(() => { void sweep(); }, sweepIntervalMs);
  timer.unref();

  async function initialize(request: Request, requestOptions: McpHandlerRequestOptions, body: unknown): Promise<Response> {
    if (products.size + constructing >= maxSessions) return errorResponse(503, "MCP session limit reached; retry after closing an idle session");
    constructing += 1;
    let entry: Session | undefined;
    try {
      const product = await factory({ era: "legacy", requestInfo: request,
        ...(requestOptions.authInfo ? { authInfo: requestOptions.authInfo } : {}),
      });
      if (closed) {
        await product.close().catch(report);
        return errorResponse(503, "MCP handler is closed");
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        ...(options.keepAliveMs === undefined ? {} : { keepAliveMs: options.keepAliveMs }),
        onsessioninitialized: (id) => { if (entry) sessions.set(id, entry); },
        onsessionclosed: () => { if (entry) forget(entry); },
      });
      entry = { product, transport, authFingerprint: authFingerprint(requestOptions.authInfo), touchedAt: Date.now() };
      products.add(entry);
      await product.connect(transport);
      const retained = entry;
      const previousClose = transport.onclose;
      transport.onclose = () => { forget(retained); previousClose?.(); };
      const response = await transport.handleRequest(request, { ...requestOptions, parsedBody: body });
      if (!transport.sessionId || response.status >= 400) await dispose(entry);
      return response;
    } catch (error) {
      if (entry) await dispose(entry);
      report(error);
      return errorResponse(500, "MCP session initialization failed");
    } finally {
      constructing -= 1;
    }
  }

  return {
    notify: fallback.notify,
    bus: fallback.bus,
    fetch: async (request, requestOptions = {}) => {
      if (closed) throw new Error("This MCP handler has been closed");
      // Use the SDK's own routing predicate: malformed modern envelopes must
      // never reach a legacy session, even if an MCP-Session-Id is supplied.
      if (request.method === "POST" && !isJsonContentType(request.headers.get("content-type"))) {
        return fallback.fetch(request, requestOptions);
      }
      if (!await isLegacyRequest(request, requestOptions.parsedBody)) return fallback.fetch(request, requestOptions);
      await sweep();
      if (closed) throw new Error("This MCP handler has been closed");
      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId) {
        const entry = sessions.get(sessionId);
        if (!entry || entry.authFingerprint !== authFingerprint(requestOptions.authInfo)) return errorResponse(404, "MCP session not found");
        entry.touchedAt = Date.now();
        return entry.transport.handleRequest(request, requestOptions);
      }
      if (request.method === "POST") {
        let body = requestOptions.parsedBody;
        if (body === undefined) {
          try { body = await request.clone().json(); } catch { return fallback.fetch(request, requestOptions); }
        }
        if (isInitializeRequest(body)) return initialize(request, requestOptions, body);
      }
      return fallback.fetch(request, requestOptions);
    },
    close: async () => {
      closed = true;
      clearInterval(timer);
      await Promise.all([fallback.close(), ...[...products].map(dispose)]);
    },
  };
}
