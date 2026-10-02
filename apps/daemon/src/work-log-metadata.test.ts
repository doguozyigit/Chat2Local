import assert from "node:assert/strict";
import test from "node:test";
import { workLogMetadata, workLogResult, toolMayHaveSideEffects } from "./work-log-metadata.js";

test("automatic history contains bounded facts, never tool payloads or URLs", () => {
  const root = "/tmp/project";
  const secret = "sk-" + "proj-fixture-credential";
  const cases = [
    ["local_dev_shell", { command: `echo ${secret}`, cwd: ".", timeoutMs: 1000 }],
    ["local_dev_file_write", { path: "notes.txt", content: secret }],
    ["local_dev_search", { query: secret, path: "." }],
    ["local_dev_web_open", { url: `https://user:${secret}@example.com/?token=${secret}` }],
    ["local_dev_browser_control", { action: "evaluate", expression: secret, text: secret }],
    ["local_dev_skills", { action: "read", id: "skill-fixture", resource: "guide.md" }],
  ] as const;
  for (const [tool, input] of cases) {
    const metadata = workLogMetadata(root, tool, input);
    assert.ok(Buffer.byteLength(JSON.stringify(metadata)) < 2048);
    assert.ok(!JSON.stringify(metadata).includes(secret));
  }
  assert.equal(workLogMetadata(root, "local_dev_file_read", { path: "/tmp/other/secret" }).path, "[outside selected folder]");
  assert.equal(workLogMetadata(root, "local_dev_file_read", { path: "/tmp/project/src/index.ts" }).path, "src/index.ts");
  assert.equal(workLogMetadata(root, "local_dev_file_read", { path: "../other" }).path, "[outside selected folder]");
});

test("nonzero shell outcomes and returned errors are recorded without their output", () => {
  const outcome = workLogResult("/tmp/project", "local_dev_shell", {
    content: [{ type: "text", text: JSON.stringify({ exitCode: 9, stdout: "private stdout", stderr: "private stderr", cwd: "/tmp/project", truncated: false }) }],
  });
  assert.equal(outcome.status, "execution_error");
  assert.equal(outcome.result.exitCode, 9);
  assert.ok(!JSON.stringify(outcome).includes("private"));
  assert.equal(workLogResult("/tmp/project", "local_dev_file_read", { isError: true, content: [] }).status, "execution_error");
  assert.equal(workLogResult("/tmp/project", "local_dev_file_write", { content: [{ type: "text", text: '{"path":"/tmp/project/a.txt","bytes":3}' }] }).result.path, "a.txt");
});

test("inspection stays available while commands, file saves and browser actions need checkpoints", () => {
  assert.equal(toolMayHaveSideEffects("local_dev_file_read", {}), false);
  assert.equal(toolMayHaveSideEffects("local_dev_browser_inspect", {}), false);
  assert.equal(toolMayHaveSideEffects("local_dev_browser_inspect", { url: "https://example.com" }), true);
  assert.equal(toolMayHaveSideEffects("local_dev_browser_control", { action: "activate" }), false);
  assert.equal(toolMayHaveSideEffects("local_dev_browser_control", { action: "evaluate" }), true);
  assert.equal(toolMayHaveSideEffects("local_dev_shell", {}), true);
});
