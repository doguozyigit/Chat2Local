import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./release-preview.mjs", import.meta.url));

async function fixture(t, { license = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "local-dev-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, "README.md", "A developer preview.\n");
  await put(root, "package.json", JSON.stringify({ name: "local-dev", version: "1.2.3", scripts: { build: "node -e \"require('fs').writeFileSync('built.txt', 'ok')\"" } }));
  await put(root, "package-lock.json", JSON.stringify({ name: "local-dev", version: "1.2.3", lockfileVersion: 3, packages: { "": { name: "local-dev", version: "1.2.3" } } }));
  await put(root, "apps/daemon/src/index.ts", "export const ready = true;\n");
  await put(root, "scripts/start.sh", "#!/bin/sh\nprintf ready\n");
  await chmod(join(root, "scripts/start.sh"), 0o755);
  if (license) await put(root, "LICENSE", "A fixture license for testing.\n");
  return root;
}

async function put(root, path, contents) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents);
}

function run(root, mode, extra = []) {
  const result = spawnSync(process.execPath, [script, mode, "--root", root, ...extra], { encoding: "utf8" });
  return { ...result, report: result.stdout.trim().startsWith("{") ? JSON.parse(result.stdout) : null };
}

test("check inventories only source and leaves runtime directories untouched", async (t) => {
  const root = await fixture(t);
  await put(root, "docs/INSTALL.md", "Setup.\n");
  await put(root, "SECURITY.md", "Report privately.\n");
  await put(root, "examples/hello/.agents/skills/demo/SKILL.md", "Example skill.\n");
  await put(root, ".github/workflows/check.yml", "name: Checks\n");
  const privateText = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  for (const path of [".local-signing/cert.pem", ".local-dev/secrets.json", "dist/private.txt", ".tmp/vault.key", "node_modules/private.txt", "apps/macos/.build/private.txt", "examples/hello/node_modules/private.txt", "unlisted.txt"]) {
    await put(root, path, privateText);
  }
  await symlink("/does/not/exist", join(root, "docs", "dist"));
  const before = await readdir(root);
  const result = run(root, "--check");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.report.findings.length, 0);
  assert.deepEqual(result.report.files, [...result.report.files].sort());
  assert.ok(result.report.files.includes("examples/hello/.agents/skills/demo/SKILL.md"));
  assert.ok(result.report.files.includes(".github/workflows/check.yml"));
  assert.ok(result.report.files.includes("SECURITY.md"));
  assert.ok(!result.report.files.some((path) => path.includes("private") || path.startsWith(".local-")));
  assert.deepEqual(await readdir(root), before, "check must not create output files");
});

test("check permits an unresolved license while export requires one", async (t) => {
  const root = await fixture(t, { license: false });
  const check = run(root, "--check");
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.ok(check.report.warnings.some((warning) => warning.rule === "license-missing"));
  const exported = run(root, "--export");
  assert.equal(exported.status, 1);
  assert.ok(exported.report.findings.some((finding) => finding.rule === "license-missing"));
  assert.ok(!(await readdir(root)).includes("dist"));
});

test("selected symlinks and credential files block export without reading targets", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "docs"));
  await symlink("/does/not/exist/private-secret", join(root, "docs", "linked.md"));
  await put(root, "docs/signing.pem", "Do not read this fixture.\n");
  await put(root, "examples/demo/secrets.json", "Do not read this fixture.\n");
  const result = run(root, "--export");
  assert.equal(result.status, 1);
  assert.deepEqual(result.report.findings.map(({ path, rule }) => ({ path, rule })), [
    { path: "docs/linked.md", rule: "source-symlink" },
    { path: "docs/signing.pem", rule: "private-or-runtime-file" },
    { path: "examples/demo/secrets.json", rule: "private-or-runtime-file" },
  ]);
  assert.ok(!(await readdir(root)).includes("dist"));
});

test("an allowed source tree reached through a parent symlink is rejected", async (t) => {
  const root = await fixture(t);
  await rm(join(root, "apps"), { recursive: true });
  await symlink("/does/not/exist", join(root, "apps"));
  const result = run(root, "--check");
  assert.equal(result.status, 1);
  assert.ok(result.report.findings.some(({ path, rule }) => path === "apps" && rule === "source-symlink"));
});

test("scan reports concrete token rules and locations without including their values", async (t) => {
  const root = await fixture(t);
  const github = ["ghp", "a".repeat(36)].join("_");
  const bearer = ["Bearer", "b".repeat(32)].join(" ");
  const apiKey = ["sk", "proj", "c".repeat(40)].join("-");
  const privateKey = ["-----BEGIN", "RSA", "PRIVATE KEY-----"].join(" ");
  const personalPath = ["/Users", "release-fixture-person", "Projects", "app"].join("/");
  await put(root, "docs/bad.md", ["Fixture", github, bearer, apiKey, privateKey, personalPath].join("\n"));
  const result = run(root, "--check");
  assert.equal(result.status, 1);
  for (const value of [github, bearer, apiKey, privateKey, personalPath]) {
    assert.ok(!result.stdout.includes(value));
    assert.ok(!result.stderr.includes(value));
  }
  for (const [rule, line] of [["github-token", 2], ["bearer-token", 3], ["openai-api-key", 4], ["private-key", 5], ["personal-home-path", 6]]) {
    assert.ok(result.report.findings.some((finding) => finding.path === "docs/bad.md" && finding.rule === rule && finding.line === line));
  }
});

test("short test tokens, environment references, and generic home paths are allowed", async (t) => {
  const root = await fixture(t);
  await put(root, "docs/safe.md", "Bearer test-token\nsk-test-secret\n$HOME/project\n/Users/$USER_NAME\n/Users/you/project\napiKey = process.env.API_KEY\n");
  const result = run(root, "--check");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(result.report.findings, []);
});

test("export is reproducible and extracts into source that installs and builds", async (t) => {
  const root = await fixture(t);
  const first = run(root, "--export");
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const archive = await readFile(first.report.archivePath);
  const second = run(root, "--export");
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.deepEqual(await readFile(second.report.archivePath), archive);
  const extract = join(root, "extract");
  await mkdir(extract);
  execFileSync("tar", ["-xzf", first.report.archivePath, "-C", extract]);
  const source = join(extract, first.report.archiveRoot);
  const manifest = JSON.parse(await readFile(join(source, "RELEASE_MANIFEST.json"), "utf8"));
  const scan = JSON.parse(await readFile(join(source, "RELEASE_SCAN.json"), "utf8"));
  assert.equal(scan.findings.length, 0);
  assert.equal(manifest.files.length, first.report.files.length);
  for (const file of manifest.files) {
    const bytes = await readFile(join(source, file.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    assert.equal(bytes.length, file.size);
  }
  assert.equal(manifest.files.find((file) => file.path === "scripts/start.sh").mode, "0755");
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: source, stdio: "pipe" });
  execFileSync("npm", ["run", "build"], { cwd: source, stdio: "pipe" });
  assert.equal(await readFile(join(source, "built.txt"), "utf8"), "ok");
});

test("archive metadata cannot use a version containing path traversal", async (t) => {
  const root = await fixture(t);
  await put(root, "package.json", JSON.stringify({ name: "local-dev", version: "../../outside" }));
  const result = run(root, "--export");
  assert.equal(result.status, 1);
  assert.ok(result.report.findings.some((finding) => finding.rule === "invalid-package-version"));
  assert.ok(!(await readdir(root)).includes("dist"));
});
