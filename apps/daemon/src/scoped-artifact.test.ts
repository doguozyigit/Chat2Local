import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeScopedArtifact } from "./scoped-artifact.js";

test("writes unique JSON and PNG artifacts into the project .tmp directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-dev-artifact-"));
  try {
    const json = '{"title":"Example"}';
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const firstJsonPath = await writeScopedArtifact(root, "browser-page", "json", json);
    const secondJsonPath = await writeScopedArtifact(root, "browser-page", "json", json);
    const pngPath = await writeScopedArtifact(root, "browser-page", "png", png);
    const artifactDir = join(await realpath(root), ".tmp");

    assert.notEqual(firstJsonPath, secondJsonPath);
    for (const path of [firstJsonPath, secondJsonPath, pngPath]) {
      assert.equal(path.startsWith(`${artifactDir}/`), true, path);
    }
    assert.match(firstJsonPath, /\/browser-page-[0-9a-f-]+\.json$/);
    assert.match(pngPath, /\/browser-page-[0-9a-f-]+\.png$/);
    assert.equal(await readFile(firstJsonPath, "utf8"), json);
    assert.deepEqual(await readFile(pngPath), png);
    assert.equal((await readdir(artifactDir)).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a .tmp symlink that escapes the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-dev-artifact-"));
  const outside = await mkdtemp(join(tmpdir(), "local-dev-artifact-outside-"));
  try {
    await symlink(outside, join(root, ".tmp"));
    await assert.rejects(
      writeScopedArtifact(root, "browser-page", "png", Buffer.from("image")),
      /escapes the Chat2Local project scope/i,
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects unsafe artifact names before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-dev-artifact-"));
  try {
    await assert.rejects(
      writeScopedArtifact(root, "../escape", "json", "{}"),
      /artifact name/i,
    );
    await assert.rejects(readFile(join(root, "escape.json")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
