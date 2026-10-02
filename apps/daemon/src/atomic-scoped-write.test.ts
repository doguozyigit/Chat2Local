import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { editScopedFile, writeScopedFile } from "./local-tools.js";
import * as localTools from "./local-tools.js";

type Phase = "stageCreated" | "stageWritten" | "staged" | "beforeCommit" | "committed";
type PhaseInfo = { phase: Phase; path: string; stagingPath: string };
function writer(onPhase: (info: PhaseInfo) => Promise<void> | void) {
  const api = localTools as typeof localTools & {
    createScopedFileWriter?: (options: { onPhase: typeof onPhase }) => {
      writeScopedFile: typeof writeScopedFile;
      editScopedFile: typeof editScopedFile;
    };
  };
  return api.createScopedFileWriter?.({ onPhase }) ?? { writeScopedFile, editScopedFile };
}

function fixture(): { root: string; file: string; dispose(): void } {
  const base = join(process.cwd(), ".tmp-tests");
  mkdirSync(base, { recursive: true });
  const root = realpathSync(mkdtempSync(join(base, "atomic-scoped-write-")));
  const file = join(root, "report.txt");
  writeFileSync(file, "alpha\nbeta\n");
  return { root, file, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("scoped saves replace the destination inode with the full new contents", async () => {
  const f = fixture();
  try {
    const before = statSync(f.file);
    await writeScopedFile(f.root, "report.txt", "complete replacement\n");
    assert.notEqual(statSync(f.file).ino, before.ino, "saving must replace a staged file instead of truncating the destination");
    assert.equal(readFileSync(f.file, "utf8"), "complete replacement\n");
    const saved = statSync(f.file);
    await editScopedFile(f.root, "report.txt", "replacement", "edit", false);
    assert.notEqual(statSync(f.file).ino, saved.ino, "edits must also replace a staged file");
    assert.equal(readFileSync(f.file, "utf8"), "complete edit\n");
  } finally { f.dispose(); }
});

test("scoped saves preserve an existing file's permission mode", async () => {
  const f = fixture();
  try {
    chmodSync(f.file, 0o751);
    await writeScopedFile(f.root, "report.txt", "replacement\n");
    assert.equal(statSync(f.file).mode & 0o7777, 0o751);
    await editScopedFile(f.root, "report.txt", "replacement", "edited", false);
    assert.equal(statSync(f.file).mode & 0o7777, 0o751);
  } finally { f.dispose(); }
});

test("concurrent scoped edits to one canonical target keep both changes", async () => {
  const f = fixture();
  try {
    await Promise.all([
      editScopedFile(f.root, "report.txt", "alpha", "alpha plus", false),
      editScopedFile(f.root, "report.txt", "beta", "beta plus", false),
    ]);
    assert.equal(readFileSync(f.file, "utf8"), "alpha plus\nbeta plus\n");
  } finally { f.dispose(); }
});

test("scoped save refuses content changed by an external editor before commit", async () => {
  const f = fixture();
  try {
    const tools = writer(({ phase }) => {
      if (phase === "staged") writeFileSync(f.file, "external replacement\n");
    });
    await assert.rejects(tools.writeScopedFile(f.root, "report.txt", "local replacement\n"), /changed/i);
    assert.equal(readFileSync(f.file, "utf8"), "external replacement\n");
    assert.deepEqual(readdirSync(f.root), ["report.txt"]);
  } finally { f.dispose(); }
});

test("scoped edit refuses a replaced target before commit", async () => {
  const f = fixture();
  try {
    const replacement = join(f.root, "replacement.txt");
    const tools = writer(({ phase }) => {
      if (phase === "beforeCommit") {
        writeFileSync(replacement, "new file identity\n");
        renameSync(replacement, f.file);
      }
    });
    await assert.rejects(tools.editScopedFile(f.root, "report.txt", "alpha", "edited", false), /changed/i);
    assert.equal(readFileSync(f.file, "utf8"), "new file identity\n");
  } finally { f.dispose(); }
});

test("scoped save refuses a final symlink introduced before commit", async () => {
  const f = fixture();
  try {
    const outside = join(f.root, "other.txt");
    writeFileSync(outside, "must survive\n");
    const tools = writer(({ phase }) => {
      if (phase === "beforeCommit") {
        rmSync(f.file);
        symlinkSync(outside, f.file);
      }
    });
    await assert.rejects(tools.writeScopedFile(f.root, "report.txt", "replacement\n"), /changed|symbolic|scope/i);
    assert.equal(readFileSync(outside, "utf8"), "must survive\n");
  } finally { f.dispose(); }
});

test("scoped save refuses an ancestor replaced with an outside symlink", async () => {
  const f = fixture();
  const outside = fixture();
  try {
    const nested = join(f.root, "nested");
    const displaced = join(f.root, "displaced");
    mkdirSync(nested);
    writeFileSync(join(nested, "report.txt"), "old nested\n");
    const tools = writer(({ phase }) => {
      if (phase === "beforeCommit") {
        renameSync(nested, displaced);
        symlinkSync(outside.root, nested);
      }
    });
    await assert.rejects(tools.writeScopedFile(f.root, "nested/report.txt", "replacement\n"), /changed|scope/i);
    assert.equal(readFileSync(outside.file, "utf8"), "alpha\nbeta\n");
    assert.equal(readFileSync(join(displaced, "report.txt"), "utf8"), "old nested\n");
    assert.deepEqual(readdirSync(outside.root), ["report.txt"]);
  } finally { f.dispose(); outside.dispose(); }
});

test("a new destination introduced before commit is not overwritten", async () => {
  const f = fixture();
  try {
    const target = join(f.root, "new.txt");
    const tools = writer(({ phase }) => {
      if (phase === "staged") writeFileSync(target, "external creation\n");
    });
    await assert.rejects(tools.writeScopedFile(f.root, "new.txt", "local creation\n"), /changed/i);
    assert.equal(readFileSync(target, "utf8"), "external creation\n");
  } finally { f.dispose(); }
});

test("scoped save refuses a selected folder replaced before commit", async () => {
  const f = fixture();
  const outside = fixture();
  const displaced = `${f.root}-displaced`;
  try {
    const tools = writer(({ phase }) => {
      if (phase === "beforeCommit") {
        renameSync(f.root, displaced);
        symlinkSync(outside.root, f.root);
      }
    });
    await assert.rejects(tools.writeScopedFile(f.root, "report.txt", "replacement\n"), /changed|scope/i);
    assert.equal(readFileSync(outside.file, "utf8"), "alpha\nbeta\n");
    assert.equal(readFileSync(join(displaced, "report.txt"), "utf8"), "alpha\nbeta\n");
    assert.deepEqual(readdirSync(outside.root), ["report.txt"]);
  } finally { f.dispose(); outside.dispose(); rmSync(displaced, { recursive: true, force: true }); }
});

test("failed staging removes its own file and preserves unrelated staging names", async () => {
  const f = fixture();
  try {
    const unrelated = join(f.root, ".local-dev-stage-999999-unrelated.tmp");
    writeFileSync(unrelated, "belongs to another operation\n");
    const tools = writer(({ phase }) => { if (phase === "stageWritten") throw new Error("injected disk failure"); });
    await assert.rejects(tools.writeScopedFile(f.root, "report.txt", "replacement\n"), /injected disk failure/);
    assert.equal(readFileSync(f.file, "utf8"), "alpha\nbeta\n");
    assert.equal(readFileSync(unrelated, "utf8"), "belongs to another operation\n");
    assert.deepEqual(readdirSync(f.root).sort(), [".local-dev-stage-999999-unrelated.tmp", "report.txt"]);
  } finally { f.dispose(); }
});

test("cleanup preserves a different inode placed at this operation's staging name", async () => {
  const f = fixture();
  try {
    let stage = "";
    const tools = writer(({ phase, stagingPath }) => {
      if (phase === "staged") {
        stage = stagingPath;
        rmSync(stage);
        writeFileSync(stage, "unrelated replacement\n");
      }
    });
    await assert.rejects(tools.writeScopedFile(f.root, "report.txt", "replacement\n"), /staging file changed/i);
    assert.equal(readFileSync(f.file, "utf8"), "alpha\nbeta\n");
    assert.equal(readFileSync(stage, "utf8"), "unrelated replacement\n");
  } finally { f.dispose(); }
});

test("scoped save refuses its staging contents being altered before commit", async () => {
  const f = fixture();
  try {
    const tools = writer(({ phase, stagingPath }) => {
      if (phase === "staged") writeFileSync(stagingPath, "corrupt replacement\n");
    });
    await assert.rejects(tools.writeScopedFile(f.root, "report.txt", "replacement\n"), /staging file changed/i);
    assert.equal(readFileSync(f.file, "utf8"), "alpha\nbeta\n");
  } finally { f.dispose(); }
});

test("concurrent writers serialize aliases of the same destination", async () => {
  const f = fixture();
  try {
    symlinkSync(f.file, join(f.root, "alias.txt"));
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let announce!: () => void;
    const entered = new Promise<void>((resolve) => { announce = resolve; });
    let firstPaused = false;
    const firstTools = writer(async ({ phase }) => {
      if (phase === "staged") { firstPaused = true; announce(); await paused; }
    });
    const first = firstTools.editScopedFile(f.root, "report.txt", "alpha", "alpha plus", false);
    await Promise.race([entered, first]);
    let secondEntered = false;
    const secondTools = writer(({ phase }) => { if (phase === "stageCreated") secondEntered = true; });
    const second = secondTools.editScopedFile(f.root, "alias.txt", "beta", "beta plus", false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const secondStartedBeforeRelease = secondEntered;
    release();
    await Promise.all([first, second]);
    assert.equal(firstPaused, true, "the first edit must reach the staged phase");
    assert.equal(secondStartedBeforeRelease, false, "the alias must share the canonical destination lock");
    assert.equal(readFileSync(f.file, "utf8"), "alpha plus\nbeta plus\n");
  } finally { f.dispose(); }
});

const crashCases: Array<{ operation: "write" | "edit" | "create"; phase: Phase }> = [
  { operation: "write", phase: "stageCreated" },
  { operation: "write", phase: "stageWritten" },
  { operation: "write", phase: "staged" },
  { operation: "write", phase: "committed" },
  { operation: "edit", phase: "staged" },
  { operation: "edit", phase: "committed" },
  { operation: "create", phase: "staged" },
  { operation: "create", phase: "committed" },
];
for (const { operation, phase } of crashCases) {
  test(`SIGKILL during ${operation} at ${phase} leaves the destination complete or absent`, async () => {
    const f = fixture();
    const target = operation === "create" ? join(f.root, "new.txt") : f.file;
    const updated = operation === "edit" ? "alpha plus\nbeta\n" : "complete new contents\n";
    const source = new URL("./local-tools.ts", import.meta.url).href;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      import * as tools from ${JSON.stringify(source)};
      const hook = async (info) => {
        if (info.phase !== ${JSON.stringify(phase)}) return;
        process.send({ phase: info.phase, stagingPath: info.stagingPath });
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      };
      const writer = tools.createScopedFileWriter?.({ onPhase: hook }) ?? tools;
      ${operation === "edit"
        ? `await writer.editScopedFile(${JSON.stringify(f.root)}, "report.txt", "alpha", "alpha plus", false);`
        : `await writer.writeScopedFile(${JSON.stringify(f.root)}, ${JSON.stringify(target)}, ${JSON.stringify(updated)});`}
      process.send({ phase: "completed-without-hook" });
    `], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
    try {
      const reached = await new Promise<{ phase: string; stagingPath?: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`child did not reach ${phase}: ${stderr}`)), 5_000);
        child.once("message", (value) => { clearTimeout(timer); resolve(value as { phase: string; stagingPath?: string }); });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`child exited ${code}/${signal}: ${stderr}`)); });
      });
      assert.equal(reached.phase, phase, "the injected phase hook must run at the requested boundary");
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
      assert.equal(child.kill("SIGKILL"), true);
      assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
      if (phase === "committed") assert.equal(readFileSync(target, "utf8"), updated);
      else if (operation === "create") assert.equal(existsSync(target), false);
      else assert.equal(readFileSync(target, "utf8"), "alpha\nbeta\n");
      if (phase !== "committed") assert.equal(existsSync(reached.stagingPath!), true, "only an operation's own stage may be left by an uncatchable kill");
    } finally { child.kill("SIGKILL"); f.dispose(); }
  });
}
