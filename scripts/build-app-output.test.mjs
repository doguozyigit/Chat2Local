import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "chat2local-build-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  return realpath(root);
}

test("build output can use an isolated branded preview directory", async t => {
  const { resolveAppOutput } = await import("./build-app-output.mjs");
  const root = await fixture(t);
  assert.equal(await resolveAppOutput(root), join(root, "dist", "Chat2Local.app"));
  assert.equal(await resolveAppOutput(root, "dist/chat2local-preview/Chat2Local.app"), join(root, "dist", "chat2local-preview", "Chat2Local.app"));
});

test("build output cannot remove an old app or a directory outside dist", async t => {
  const { resolveAppOutput } = await import("./build-app-output.mjs");
  const root = await fixture(t), legacy = join(root, "dist", "Local Dev.app");
  await mkdir(legacy); await writeFile(join(legacy, "canary"), "running bundle untouched");
  for (const path of [legacy, "Chat2Local.app", "dist", "dist/Local Dev.app/Chat2Local.app", "dist/../../Chat2Local.app"]) {
    await assert.rejects(resolveAppOutput(root, path), /Chat2Local\.app|outside|inside|legacy|dist/);
  }
  assert.equal(await readFile(join(legacy, "canary"), "utf8"), "running bundle untouched");
});

test("build output rejects symlinks in its target and parent directories", async t => {
  const { resolveAppOutput } = await import("./build-app-output.mjs");
  const root = await fixture(t), elsewhere = join(root, "elsewhere");
  await mkdir(elsewhere); await writeFile(join(elsewhere, "canary"), "untouched");
  await symlink(elsewhere, join(root, "dist", "alias"));
  await symlink(elsewhere, join(root, "dist", "Chat2Local.app"));
  await assert.rejects(resolveAppOutput(root), /symlink/);
  await assert.rejects(resolveAppOutput(root, "dist/alias/Chat2Local.app"), /symlink/);
  assert.equal(await readFile(join(elsewhere, "canary"), "utf8"), "untouched");
});
