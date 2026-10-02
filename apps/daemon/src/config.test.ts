import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";

test("packaged daemon discovers its adjacent executable tunnel client", () => {
  const root = mkdtempSync(join(tmpdir(), "local-dev-bundled-tunnel-"));
  const originalArguments = [...process.argv];
  const originalOverride = process.env.LOCAL_DEV_TUNNEL_CLIENT;
  try {
    delete process.env.LOCAL_DEV_TUNNEL_CLIENT;
    process.argv[1] = join(root, "local-devd.mjs");
    const client = join(root, "tunnel-client");
    assert.equal(loadConfig().tunnelClientExecutable, null);
    writeFileSync(client, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.equal(loadConfig().tunnelClientExecutable, client);
    process.env.LOCAL_DEV_TUNNEL_CLIENT = "/explicit/client";
    assert.equal(loadConfig().tunnelClientExecutable, "/explicit/client");
  } finally {
    process.argv = originalArguments;
    if (originalOverride === undefined) delete process.env.LOCAL_DEV_TUNNEL_CLIENT;
    else process.env.LOCAL_DEV_TUNNEL_CLIENT = originalOverride;
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundled tunnel discovery rejects non-executables, directories, and links", () => {
  const root = mkdtempSync(join(tmpdir(), "local-dev-bundled-invalid-"));
  const originalArguments = [...process.argv];
  const originalOverride = process.env.LOCAL_DEV_TUNNEL_CLIENT;
  try {
    delete process.env.LOCAL_DEV_TUNNEL_CLIENT;
    process.argv[1] = join(root, "local-devd.mjs");
    const client = join(root, "tunnel-client");
    writeFileSync(client, "not executable", { mode: 0o644 });
    assert.equal(loadConfig().tunnelClientExecutable, null);
    rmSync(client);
    mkdirSync(client);
    assert.equal(loadConfig().tunnelClientExecutable, null);
    rmSync(client, { recursive: true });
    const target = join(root, "other");
    writeFileSync(target, "#!/bin/sh\nexit 0\n");
    chmodSync(target, 0o755);
    symlinkSync(target, client);
    assert.equal(loadConfig().tunnelClientExecutable, null);
  } finally {
    process.argv = originalArguments;
    if (originalOverride === undefined) delete process.env.LOCAL_DEV_TUNNEL_CLIENT;
    else process.env.LOCAL_DEV_TUNNEL_CLIENT = originalOverride;
    rmSync(root, { recursive: true, force: true });
  }
});
