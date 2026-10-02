#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { ChatFolderStore } from "./chat-folder-store.js";
import { createLocalDevMcpHandler } from "./mcp.js";
import { createLocalHttpServer } from "./http.js";
import { TunnelManager } from "./tunnel-manager.js";
import { BackgroundBrowserPool } from "./background-browser.js";
import { loadOrCreateApiToken } from "./api-auth.js";
import { acquireDaemonStateLock } from "./daemon-lock.js";

const VERSION = "0.3.0";
const startedAt = new Date().toISOString();
const config = loadConfig();
// Own the state before recovery storage can classify earlier operations.
const stateLock = acquireDaemonStateLock(config.databasePath);
const authToken = loadOrCreateApiToken(config.dataDir);
const apiUrl = `http://${config.host}:${config.port}`;
const mcpUrl = `${apiUrl}/mcp`;
const chats = new ChatFolderStore(config.databasePath);
const tunnel = new TunnelManager(mcpUrl, config.dataDir, config.tunnelClientExecutable, authToken);
const backgroundBrowsers = new BackgroundBrowserPool(config.dataDir);
const mcpHandler = createLocalDevMcpHandler({ chats, version: VERSION, startedAt, apiUrl, mcpUrl, backgroundBrowsers, tunnelStatus: () => tunnel.status() });
const server = createLocalHttpServer({ host: config.host, port: config.port, version: VERSION, startedAt, chats, mcpHandler, tunnel, authToken,
  onFolderChanged: (id, revision) => backgroundBrowsers.releaseChat(`${id}:${revision}`) });
server.listen(config.port, config.host, () => { console.error(`Chat2Local ${VERSION} listening on ${apiUrl}`); });
server.on("error", (error) => { console.error(`Chat2Local service failed: ${error.message}`); void shutdown().finally(() => process.exit(1)); });
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    // Stop accepting new scopes before closing their resources.
    const stopped = new Promise<void>((resolve) => { server.close(() => resolve()); });
    await tunnel.stop();
    await mcpHandler.close();
    await stopped;
    await backgroundBrowsers.closeAll();
  } finally {
    try { chats.close(); }
    finally { stateLock.release(); }
  }
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void shutdown().finally(() => process.exit(0)); });
}
const parentPid = Number.parseInt(process.env.LOCAL_DEV_PARENT_PID ?? "", 10);
if (Number.isFinite(parentPid) && parentPid > 1) {
  const watch = setInterval(() => {
    try { process.kill(parentPid, 0); } catch { clearInterval(watch); void shutdown().finally(() => process.exit(0)); }
  }, 1000);
  watch.unref();
}
