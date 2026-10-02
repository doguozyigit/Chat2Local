import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BackgroundBrowserController,
  BackgroundBrowserPool,
} from "./background-browser.js";

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "local-dev-browser-"));
  const executablePath = join(dataDir, "fake-brave");
  writeFileSync(executablePath, `#!${process.execPath}
const { closeSync, createReadStream, existsSync, readFileSync, writeFileSync, appendFileSync, writeSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const profile = args.find((arg) => arg.startsWith("--user-data-dir="))?.slice(16);
if (!profile || !args.includes("--remote-debugging-pipe") || args.some((arg) => arg.startsWith("--remote-debugging-port=") || arg.startsWith("--remote-debugging-address="))) process.exit(13);
appendFileSync(join(profile, "launches"), JSON.stringify({ pid: process.pid, args }) + "\\n");
const statePath = join(profile, "page.json");
let page = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { id: "page-1", title: "Example", url: "https://example.test/" };
const save = () => writeFileSync(statePath, JSON.stringify(page));
const send = (message) => writeSync(4, JSON.stringify(message) + "\\0");
const input = createReadStream(null, { fd: 3, autoClose: false });
let pending = Buffer.alloc(0);
input.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const end = pending.indexOf(0);
    if (end < 0) break;
    const frame = pending.subarray(0, end).toString("utf8");
    pending = pending.subarray(end + 1);
    const command = JSON.parse(frame);
    let result = {};
    switch (command.method) {
      case "Browser.getVersion": result = { product: "Fake Brave" }; break;
      case "Browser.close": send({ id: command.id, result }); process.exit(0);
      case "Target.getTargets": result = { targetInfos: [{ targetId: page.id, title: page.title, url: page.url, type: "page" }] }; break;
      case "Target.createTarget": page = { id: "page-1", title: "", url: command.params.url }; save(); result = { targetId: page.id }; break;
      case "Target.attachToTarget": result = { sessionId: "session-1" }; break;
      case "Target.detachFromTarget": break;
      case "Page.getLayoutMetrics": result = { cssLayoutViewport: { clientWidth: 1440, clientHeight: 1000 } }; break;
      case "Page.navigate":
        if (command.params.url === "https://pipe-crash.test/") { closeSync(4); setInterval(() => {}, 1000); return; }
        if (command.params.url === "https://bad.test/") { result = { errorText: "net::ERR_NAME_NOT_RESOLVED" }; break; }
        page.url = command.params.url;
        page.title = page.url.startsWith("chrome-error://") ? "Site can't be reached" : "Loaded";
        save();
        break;
      case "Runtime.evaluate": result = { result: { value: command.params.expression === "document.readyState" ? "complete" : page.url } }; break;
      case "Page.captureScreenshot": result = { data: Buffer.from("fake-png").toString("base64") }; break;
    }
    send({ id: command.id, result });
  }
});
input.on("end", () => process.exit(0));
`);
  chmodSync(executablePath, 0o755);
  return { dataDir, executablePath };
}

function launches(profileDir: string): Array<{ pid: number; args: string[] }> {
  return readFileSync(join(profileDir, "launches"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { pid: number; args: string[] });
}

test("startup failures preserve launcher stderr and the actual exit code", async () => {
  const { dataDir, executablePath } = fixture();
  writeFileSync(executablePath, `#!${process.execPath}
const { writeSync } = require("node:fs");
writeSync(2, "sandbox-exec: sandbox_apply: Operation not permitted\\n");
process.exit(71);
`);
  const browser = new BackgroundBrowserController(dataDir, { executablePath });
  try {
    await assert.rejects(browser.inspect(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /sandbox_apply: Operation not permitted/);
      assert.match(error.message, /exited \(71\)/);
      return true;
    });
  } finally {
    await browser.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("failed wrapped startup terminates descendants before losing process-group ownership", { timeout: 6000 }, async () => {
  const { dataDir, executablePath } = fixture();
  const receipt = join(dataDir, "descendant.json");
  writeFileSync(executablePath, `#!${process.execPath}
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ group: process.pid, descendant: child.pid }));
process.exit(21);
`);
  const browser = new BackgroundBrowserController(dataDir, {
    executablePath, launch: { command: executablePath, argsPrefix: [] },
  });
  let group: number | undefined;
  try {
    await assert.rejects(browser.inspect(), /exited \(21\)/);
    const observed = JSON.parse(readFileSync(receipt, "utf8")) as { group: number; descendant: number };
    group = observed.group;
    await browser.close();
    let alive = true;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { process.kill(observed.descendant, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        alive = false; break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(alive, false, "a failed wrapped browser must not leave its descendant alive");
  } finally {
    if (group === undefined) {
      try { group = (JSON.parse(readFileSync(receipt, "utf8")) as { group: number }).group; } catch {}
    }
    if (group !== undefined) { try { process.kill(-group, "SIGKILL"); } catch {} }
    await browser.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("startup diagnostics retain a bounded stderr tail", async () => {
  const { dataDir, executablePath } = fixture();
  writeFileSync(executablePath, `#!${process.execPath}
const { writeSync } = require("node:fs");
writeSync(2, "x".repeat(32_000) + "\\nDIAGNOSTIC_TAIL_MARKER\\n");
process.exit(72);
`);
  const browser = new BackgroundBrowserController(dataDir, { executablePath });
  try {
    await assert.rejects(browser.inspect(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /DIAGNOSTIC_TAIL_MARKER/);
      assert.match(error.message, /exited \(72\)/);
      assert.ok(Buffer.byteLength(error.message) < 9_000);
      return true;
    });
  } finally {
    await browser.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("each scope launches Brave with private CDP pipes and a separate profile", async () => {
  const { dataDir, executablePath } = fixture();
  const pool = new BackgroundBrowserPool(dataDir, { executablePath });
  try {
    const chatA = pool.forChat("session-1");
    const chatB = pool.forChat("chat-b");
    const chatC = pool.forChat("chat-c");
    assert.equal(pool.forChat("session-1"), chatA);
    assert.equal(pool.forChat("chat-b"), chatB);
    assert.notEqual(chatA.profileDir, chatB.profileDir);
    assert.notEqual(chatB.profileDir, chatC.profileDir);
    assert.ok(chatB.profileDir.startsWith(dataDir + "/"));
    assert.equal(chatB.profileDir.split("/").at(-1)?.includes("chat-b"), false);

    await Promise.all([
      chatA.focusTab("example.test"),
      chatB.focusTab("example.test"),
      chatC.focusTab("example.test"),
    ]);
    for (const browser of [chatA, chatB, chatC]) {
      assert.equal(browser.port, 0);
      assert.equal(launches(browser.profileDir).length, 1);
      assert.ok(launches(browser.profileDir)[0]?.args.includes("--remote-debugging-pipe"));
    }
  } finally {
    await pool.closeAll();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("pipe commands navigate, evaluate, inspect, and capture a page", async () => {
  const { dataDir, executablePath } = fixture();
  const pool = new BackgroundBrowserPool(dataDir, { executablePath });
  try {
    const first = pool.forChat("chat-b");
    const second = pool.forChat("chat-c");
    const target = await first.navigate("https://private.example/path");
    assert.equal(target.url, "https://private.example/path");
    assert.equal(await first.evaluate("location.href"), "https://private.example/path");
    assert.equal((await first.inspect()).target.url, "https://private.example/path");
    assert.deepEqual(await first.screenshot(), Buffer.from("fake-png"));
    assert.equal((await second.inspect()).target.url, "https://example.test/");
  } finally {
    await pool.closeAll();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("concurrent commands start one browser and profile survives a pool restart", async () => {
  const { dataDir, executablePath } = fixture();
  const firstPool = new BackgroundBrowserPool(dataDir, { executablePath });
  const secondPool = new BackgroundBrowserPool(dataDir, { executablePath });
  try {
    const first = firstPool.forChat("chat-b");
    await Promise.all([
      first.focusTab("example.test"),
      first.focusTab("example.test"),
      first.focusTab("example.test"),
    ]);
    assert.equal(launches(first.profileDir).length, 1);
    await first.navigate("https://saved.example/");
    await firstPool.closeAll();

    const restarted = secondPool.forChat("chat-b");
    assert.equal(restarted.profileDir, first.profileDir);
    assert.equal((await restarted.inspect()).target.url, "https://saved.example/");
    assert.equal(launches(first.profileDir).length, 2);
  } finally {
    await secondPool.closeAll();
    await firstPool.closeAll();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("release during launch closes the chat's browser", async () => {
  const { dataDir, executablePath } = fixture();
  const pool = new BackgroundBrowserPool(dataDir, { executablePath });
  try {
    const browser = pool.forChat("chat-b");
    const launching = browser.focusTab("example.test").catch(() => null);
    await pool.releaseChat("chat-b");
    await launching;
    assert.notEqual(pool.forChat("chat-b"), browser);
  } finally {
    await pool.closeAll();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("navigation errors from CDP are reported to the caller", async () => {
  const { dataDir, executablePath } = fixture();
  const browser = new BackgroundBrowserController(dataDir, { executablePath });
  try {
    await assert.rejects(
      browser.navigate("https://bad.test/"),
      /net::ERR_NAME_NOT_RESOLVED/,
    );
    await assert.rejects(
      browser.navigate("chrome-error://chromewebdata/"),
      /navigation failed|error page/i,
    );
  } finally {
    await browser.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a broken CDP pipe stops its browser and rejects the pending command", async () => {
  const { dataDir, executablePath } = fixture();
  const browser = new BackgroundBrowserController(dataDir, {
    port: 43_128,
    executablePath,
  });
  try {
    await assert.rejects(
      browser.navigate("https://pipe-crash.test/"),
      /CDP pipe|Brave exited/i,
    );
    const pid = launches(browser.profileDir)[0]?.pid;
    assert.ok(pid);
    let alive = true;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(alive, false);
  } finally {
    await browser.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
