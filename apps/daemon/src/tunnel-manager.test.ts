import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TunnelManager } from "./tunnel-manager.js";

test("OpenAI tunnel configuration is stored in memory and reported safely", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-dev-tunnel-test-"));
  try {
    const tunnel = new TunnelManager(
      "http://127.0.0.1:43127/mcp",
      directory,
      "/bin/true",
    );

    assert.equal(tunnel.status().accessConfigured, false);
    assert.equal(tunnel.status().provider, null);

    const configured = tunnel.configure({
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeApiKey: "sk-test-secret",
    });

    assert.equal(configured.accessConfigured, true);
    assert.equal(configured.tunnelId, "tunnel_0123456789abcdef0123456789abcdef");
    assert.equal(configured.provider, "OpenAI Secure MCP Tunnel");
    assert.equal(configured.connected, false);
    assert.equal(JSON.stringify(configured).includes("sk-test-secret"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid tunnel ids are rejected", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-dev-tunnel-test-"));
  try {
    const tunnel = new TunnelManager(
      "http://127.0.0.1:43127/mcp",
      directory,
      "/bin/true",
    );

    assert.throws(
      () =>
        tunnel.configure({
          tunnelId: "not-a-tunnel",
          runtimeApiKey: "sk-test-secret",
        }),
      /Tunnel ID/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tunnel forwards local API token through extra headers without argv exposure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-dev-tunnel-auth-"));
  const executable = join(directory, "fake-tunnel-client");
  const capturePath = join(directory, "capture.json");
  const token = "a".repeat(64);
  writeFileSync(join(directory, "api-token"), `${token}\n`, { mode: 0o600 });
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const server = http.createServer((req, res) => { res.writeHead(200); res.end('ready'); });
server.listen(0, '127.0.0.1', () => {
  const header = flag('--mcp.extra-headers');
  const tokenFile = header.slice('x-local-dev-token: file:'.length);
  fs.writeFileSync(process.env.LOCAL_DEV_TEST_TUNNEL_CAPTURE, JSON.stringify({
    args, apiToken: process.env.LOCAL_DEV_TUNNEL_API_TOKEN,
    forwardedToken: fs.readFileSync(tokenFile, 'utf8').trim(),
  }));
  fs.writeFileSync(flag('--health.url-file'), 'http://127.0.0.1:' + server.address().port);
  fs.writeFileSync(flag('--pid.file'), String(process.pid));
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  chmodSync(executable, 0o700);
  const previous = process.env.LOCAL_DEV_TEST_TUNNEL_CAPTURE;
  process.env.LOCAL_DEV_TEST_TUNNEL_CAPTURE = capturePath;
  const tunnel = new TunnelManager("http://127.0.0.1:43127/mcp", directory, executable, token);
  try {
    tunnel.configure({
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeApiKey: "sk-test-secret",
    });
    await tunnel.start();
    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      args: string[];
      apiToken?: string;
      forwardedToken?: string;
    };
    assert.equal(capture.apiToken, undefined);
    assert.equal(capture.forwardedToken, token);
    assert.ok(capture.args.includes("--mcp.extra-headers"));
    assert.ok(capture.args.includes(`x-local-dev-token: file:${join(directory, "api-token")}`));
    assert.ok(capture.args.includes("--mcp.discovery-extra-headers"));
    assert.equal(capture.args.join(" ").includes(token), false);
  } finally {
    await tunnel.stop();
    if (previous === undefined) delete process.env.LOCAL_DEV_TEST_TUNNEL_CAPTURE;
    else process.env.LOCAL_DEV_TEST_TUNNEL_CAPTURE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tunnel refuses an API token file that became readable by other users", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-dev-tunnel-unsafe-token-"));
  let tunnel: TunnelManager | undefined;
  try {
    const token = "b".repeat(64);
    const tokenPath = join(directory, "api-token");
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    chmodSync(tokenPath, 0o644);
    tunnel = new TunnelManager(
      "http://127.0.0.1:43127/mcp", directory, "/bin/true", token,
    );
    tunnel.configure({
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeApiKey: "sk-test-secret",
    });
    await assert.rejects(tunnel.start(), /permissions/i);
  } finally {
    await tunnel?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a tunnel client that exits cleanly is no longer reported connected", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-dev-tunnel-exit-"));
  const executable = join(directory, "fake-tunnel-client");
  const token = "c".repeat(64);
  writeFileSync(join(directory, "api-token"), `${token}\n`, { mode: 0o600 });
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const server = http.createServer((req, res) => { res.writeHead(200); res.end('ready'); });
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(flag('--health.url-file'), 'http://127.0.0.1:' + server.address().port);
  fs.writeFileSync(flag('--pid.file'), String(process.pid));
  setTimeout(() => server.close(() => process.exit(0)), 400);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  chmodSync(executable, 0o700);

  const tunnel = new TunnelManager(
    "http://127.0.0.1:43127/mcp", directory, executable, token,
  );
  try {
    tunnel.configure({
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeApiKey: "sk-test-secret",
    });
    await tunnel.start();
    assert.equal(tunnel.status().connected, true);

    const deadline = Date.now() + 2_000;
    while (tunnel.status().connected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(tunnel.status().state, "off");
    assert.equal(tunnel.status().connected, false);
  } finally {
    await tunnel.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
