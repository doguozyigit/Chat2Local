import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { SkillCatalog } from "./skill-catalog.js";

async function skill(path: string, name: string, description: string, body = "Use this guidance.") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`);
}

test("catalog discovers installed and project skills, paginates, and keeps duplicate names distinct", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-dev-skills-"));
  try {
    const project = join(base, "project");
    const codexHome = join(base, "codex");
    const agentsSkillsRoot = join(base, "agents", "skills");
    await skill(join(project, ".agents", "skills", "brainstorming", "SKILL.md"), "brainstorming", "Project approach");
    await skill(join(codexHome, "skills", "brainstorming", "SKILL.md"), "brainstorming", "Installed approach");
    await skill(join(agentsSkillsRoot, "review", "SKILL.md"), "review", "Review the work");
    await skill(join(codexHome, "plugins", "cache", "vendor", "tool", "1.0.0", "skills", "chart", "SKILL.md"), "chart", "Make charts");
    const catalog = new SkillCatalog({ codexHome, agentsSkillsRoot });
    const first = await catalog.list(project, { limit: 2 });
    assert.equal(first.total, 4);
    assert.equal(first.skills.length, 2);
    assert.equal(first.nextOffset, 2);
    assert.ok(first.skills.every((item) => !Object.hasOwn(item, "content")));
    const second = await catalog.list(project, { offset: first.nextOffset!, limit: 2 });
    assert.equal(second.nextOffset, null);
    const all = [...first.skills, ...second.skills];
    assert.deepEqual(new Set(all.map((item) => item.source)), new Set(["project", "codex", "agents", "plugin"]));
    const duplicates = all.filter((item) => item.name === "brainstorming");
    assert.equal(duplicates.length, 2);
    assert.notEqual(duplicates[0]!.id, duplicates[1]!.id);
    assert.deepEqual((await catalog.list(project, { query: "chart" })).skills.map((item) => item.name), ["chart"]);
    assert.match((await catalog.read(project, duplicates[0]!.id)).content, /# brainstorming/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("catalog will not follow symlinks or read resources outside a selected skill", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-dev-skills-"));
  try {
    const project = join(base, "project");
    const outside = join(base, "private.txt");
    const skillDir = join(project, "skills", "safe");
    await skill(join(skillDir, "SKILL.md"), "safe", "Safe guidance", "See [guide](references/guide.md).");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(join(skillDir, "references", "guide.md"), "A bounded reference.");
    await writeFile(outside, "secret");
    await symlink(outside, join(skillDir, "references", "leak.md"));
    await symlink(dirname(outside), join(project, "skills", "linked"));
    const catalog = new SkillCatalog({ codexHome: join(base, "empty-codex"), agentsSkillsRoot: join(base, "empty-agents") });
    const listed = await catalog.list(project);
    assert.deepEqual(listed.skills.map((item) => item.name), ["safe"]);
    const id = listed.skills[0]!.id;
    assert.equal((await catalog.read(project, id, "references/guide.md")).content, "A bounded reference.");
    await assert.rejects(catalog.read(project, id, "../private.txt"), /resource|path|traversal/i);
    await assert.rejects(catalog.read(project, id, "/etc/passwd"), /resource|path|absolute/i);
    await assert.rejects(catalog.read(project, id, "references/leak.md"), /symlink|resource|path/i);
    await assert.rejects(catalog.read(project, id, "references/guide.png"), /text|extension|resource/i);
    await assert.rejects(catalog.read(project, "../../private.txt"), /unknown skill/i);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("catalog reports oversized skill text without returning its content", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-dev-skills-"));
  try {
    const project = join(base, "project");
    await skill(join(project, "skills", "long", "SKILL.md"), "long", "Large skill", "x".repeat(256 * 1024));
    const catalog = new SkillCatalog({ codexHome: join(base, "empty-codex"), agentsSkillsRoot: join(base, "empty-agents") });
    const listed = await catalog.list(project);
    assert.equal(listed.total, 1);
    await assert.rejects(catalog.read(project, listed.skills[0]!.id), /256 KiB|too large/i);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("metadata scan rejects a skill directory swapped to an outside symlink before open", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-dev-skills-race-"));
  const originalOpen = fs.promises.open;
  try {
    const project = join(base, "project");
    const directory = join(project, "skills", "guide");
    const outside = join(base, "outside");
    const target = join(directory, "SKILL.md");
    await skill(target, "guide", "Project guidance");
    await skill(join(outside, "SKILL.md"), "private-skill", "Private guidance", "secret content");
    const canonicalTarget = await realpath(target);
    let swapped = false;
    fs.promises.open = async (...args: Parameters<typeof originalOpen>) => {
      if (!swapped && args[0] === canonicalTarget) {
        swapped = true;
        await rename(directory, `${directory}-saved`);
        await symlink(outside, directory);
      }
      return originalOpen(...args);
    };
    syncBuiltinESMExports();
    const catalog = new SkillCatalog({ codexHome: join(base, "empty-codex"), agentsSkillsRoot: join(base, "empty-agents") });
    const listed = await catalog.list(project);
    assert.equal(swapped, true);
    assert.equal(listed.skills.some((item) => item.name === "private-skill"), false);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  }
});

test("skill read rejects a directory swapped to an outside symlink before content open", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-dev-skills-race-"));
  const originalOpen = fs.promises.open;
  try {
    const project = join(base, "project");
    const directory = join(project, "skills", "guide");
    const outside = join(base, "outside");
    const target = join(directory, "SKILL.md");
    await skill(target, "guide", "Project guidance", "Safe content");
    await skill(join(outside, "SKILL.md"), "private-skill", "Private guidance", "secret content");
    const canonicalTarget = await realpath(target);
    const catalog = new SkillCatalog({ codexHome: join(base, "empty-codex"), agentsSkillsRoot: join(base, "empty-agents") });
    const id = (await catalog.list(project)).skills[0]!.id;
    let opens = 0;
    fs.promises.open = async (...args: Parameters<typeof originalOpen>) => {
      if (args[0] === canonicalTarget && ++opens === 2) {
        await rename(directory, `${directory}-saved`);
        await symlink(outside, directory);
      }
      return originalOpen(...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(catalog.read(project, id), /changed|symlink|path|outside|mismatch|ELOOP/i);
    assert.equal(opens, 2);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  }
});

test("Darwin open atomically rejects an intermediate symlink after path validation", { skip: process.platform !== "darwin" }, async () => {
  const base = await mkdtemp(join(tmpdir(), "local-dev-skills-race-"));
  const originalOpen = fs.promises.open;
  try {
    const project = join(base, "project");
    const directory = join(project, "skills", "guide");
    const outside = join(base, "outside");
    const target = join(directory, "SKILL.md");
    await skill(target, "guide", "Project guidance", "Safe content");
    await skill(join(outside, "SKILL.md"), "private-skill", "Private guidance", "secret content");
    const canonicalTarget = await realpath(target);
    const catalog = new SkillCatalog({ codexHome: join(base, "empty-codex"), agentsSkillsRoot: join(base, "empty-agents") });
    const id = (await catalog.list(project)).skills[0]!.id;
    let opens = 0;
    let contentOpenFlags = 0;
    fs.promises.open = async (...args: Parameters<typeof originalOpen>) => {
      if (args[0] === canonicalTarget && ++opens === 2) {
        contentOpenFlags = args[1] as number;
        await rename(directory, `${directory}-saved`);
        await symlink(outside, directory);
      }
      return originalOpen(...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(catalog.read(project, id), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ELOOP"
    );
    assert.equal(opens, 2);
    assert.notEqual(contentOpenFlags & 0x20000000, 0);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  }
});
