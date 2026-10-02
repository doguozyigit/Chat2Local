import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { editScopedFile, listScopedDirectory, readScopedFile, runScopedShell, searchScopedText, writeScopedFile } from "./local-tools.js";

test("selected folder reads, lists and searches refuse outside paths", async () => {
  const testRoot = join(process.cwd(), ".tmp-tests");
  mkdirSync(testRoot, { recursive: true });
  const base = realpathSync(mkdtempSync(join(testRoot, "local-tools-scoped-read-")));
  const project = join(base, "project");
  const outside = join(base, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  writeFileSync(join(project, "report.txt"), "project needle\n");
  writeFileSync(join(outside, "secret.txt"), "outside needle\n");
  symlinkSync(join(outside, "secret.txt"), join(project, "escape.txt"));
  try {
    assert.equal((await readScopedFile(project, "report.txt")).content, "project needle\n");
    assert.ok((await listScopedDirectory(project)).entries.some((entry) => entry.name === "report.txt"));
    assert.match((await searchScopedText(project, "needle")).matches[0]!, /report\.txt:1:project needle$/);
    await assert.rejects(readScopedFile(project, join(outside, "secret.txt")), /scope/i);
    await assert.rejects(readScopedFile(project, "escape.txt"), /scope/i);
    await assert.rejects(listScopedDirectory(project, outside), /scope/i);
    await assert.rejects(searchScopedText(project, "needle", outside), /scope/i);
    await assert.rejects(writeScopedFile(project, join(outside, "new.txt"), "must not write"), /scope/i);
    await assert.rejects(editScopedFile(project, join(outside, "secret.txt"), "outside", "edited", false), /scope/i);
    await assert.rejects(runScopedShell(project, "pwd", outside, 1000), /scope/i);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("selected folder reads accept its canonical aliases and conceal unrelated paths", async () => {
  const testRoot = join(process.cwd(), ".tmp-tests");
  mkdirSync(testRoot, { recursive: true });
  const base = realpathSync(mkdtempSync(join(testRoot, "local-tools-alias-read-")));
  const project = join(base, "project");
  const outside = join(base, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  writeFileSync(join(project, "report.txt"), "project value\n");
  writeFileSync(join(outside, "secret.txt"), "outside value\n");
  const alias = join(base, "project-alias");
  const outsideAlias = join(base, "outside-alias");
  symlinkSync(project, alias);
  symlinkSync(outside, outsideAlias);
  try {
    const read = await readScopedFile(project, join(alias, "report.txt"));
    assert.equal(read.content, "project value\n");
    assert.equal(read.path, join(project, "report.txt"));
    const refusals: string[] = [];
    for (const path of [join(outside, "secret.txt"), join(outside, "missing.txt"), join(outsideAlias, "secret.txt"), join(outsideAlias, "missing.txt"), join(base, "no-such-dir", "missing.txt")]) {
      await assert.rejects(readScopedFile(project, path).catch((error: Error) => { refusals.push(error.message); throw error; }), /scope/i);
    }
    assert.equal(new Set(refusals).size, 1, "existing and missing unrelated paths must fail identically");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("scoped writes refuse symlinks that leave the project, including dangling ones", async () => {
  const testRoot = join(process.cwd(), ".tmp-tests");
  mkdirSync(testRoot, { recursive: true });
  const base = mkdtempSync(join(testRoot, "local-tools-symlink-write-"));
  const project = join(base, "project");
  const outside = join(base, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  writeFileSync(join(project, "inside.txt"), "inside\n");
  writeFileSync(join(outside, "existing.txt"), "outside\n");
  const missingTarget = join(outside, "missing.txt");
  symlinkSync(missingTarget, join(project, "dangling.txt"));
  symlinkSync(join(outside, "existing.txt"), join(project, "to-existing.txt"));
  symlinkSync(join(outside, "missing-dir"), join(project, "dangling-dir"));
  symlinkSync(join(project, "inside.txt"), join(project, "inside-link.txt"));

  try {
    await assert.rejects(
      writeScopedFile(project, "dangling.txt", "escaped"),
      /broken symbolic link|project scope/i,
    );
    assert.equal(existsSync(missingTarget), false);

    await assert.rejects(
      writeScopedFile(project, "dangling-dir/nested/file.txt", "escaped"),
      /broken symbolic link|project scope/i,
    );
    assert.equal(existsSync(join(outside, "missing-dir")), false);

    await assert.rejects(
      writeScopedFile(project, "to-existing.txt", "escaped"),
      /project scope/i,
    );
    assert.equal(readFileSync(join(outside, "existing.txt"), "utf8"), "outside\n");

    await assert.rejects(
      editScopedFile(project, "dangling.txt", "a", "b", false),
      /ENOENT|broken symbolic link|project scope/i,
    );

    // A link that stays inside the project still works and edits its target.
    const viaLink = await writeScopedFile(project, "inside-link.txt", "updated\n");
    assert.equal(readFileSync(join(project, "inside.txt"), "utf8"), "updated\n");
    assert.equal(viaLink.bytes, 8);

    const created = await writeScopedFile(project, "new/dir/file.txt", "created\n");
    assert.equal(readFileSync(created.path, "utf8"), "created\n");
    const edited = await editScopedFile(project, "new/dir/file.txt", "created", "edited", false);
    assert.equal(edited.replacements, 1);
    assert.equal(readFileSync(created.path, "utf8"), "edited\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("scoped text search works without requiring ripgrep", async () => {
  const testRoot = join(process.cwd(), ".tmp-tests");
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(join(testRoot, "local-tools-search-"));

  try {
    mkdirSync(join(root, "nested"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });

    writeFileSync(
      join(root, "nested", "visible.txt"),
      "first line\nneedle value\n",
    );
    writeFileSync(join(root, "node_modules", "ignored.txt"), "needle\n");
    writeFileSync(join(root, "dist", "ignored.txt"), "needle\n");

    const result = await searchScopedText(root, "needle");

    assert.equal(result.truncated, false);
    assert.equal(result.matches.length, 1);
    assert.match(result.matches[0]!, /nested\/visible\.txt:2:needle value$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scoped text search caps results at 250", async () => {
  const testRoot = join(process.cwd(), ".tmp-tests");
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(join(testRoot, "local-tools-search-cap-"));

  try {
    writeFileSync(
      join(root, "many.txt"),
      Array.from({ length: 251 }, (_, index) => `needle ${index}\n`).join(""),
    );

    const result = await searchScopedText(root, "needle");

    assert.equal(result.matches.length, 250);
    assert.equal(result.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
