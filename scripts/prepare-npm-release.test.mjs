import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("./prepare-npm-release.mjs", import.meta.url));

async function cli(args) {
  try {
    const result = await execute(process.execPath, [script, ...args], { maxBuffer: 256 * 1024, timeout: 60_000 });
    return { ...result, code: 0 };
  } catch (error) { return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code }; }
}

function manifest(arch, repository = "example/chat2local", version = "0.3.0") {
  return { schemaVersion: 1, version, assets: [{ platform: "darwin", arch, app: {
    url: `https://github.com/${repository}/releases/download/v${version}/chat2local-${version}-darwin-${arch}.zip`,
    sha256: "a".repeat(64), size: 42,
  } }] };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "local-dev-npm-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "installer");
  await mkdir(join(source, "bin"), { recursive: true });
  await mkdir(join(source, "src"));
  await mkdir(join(source, "test"));
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "chat2local-installer-preview", version: "0.3.0", private: true,
    type: "module", license: "MIT", description: "Installer fixture", bin: { "chat2local": "bin/chat2local.mjs" }, engines: { node: ">=22" },
    scripts: { prepack: "node -e \"throw new Error('Do not run package hooks')\"" } }));
  await writeFile(join(source, "bin", "chat2local.mjs"), "#!/usr/bin/env node\nconsole.log('fixture');\n");
  await chmod(join(source, "bin", "chat2local.mjs"), 0o755);
  await writeFile(join(source, "src", "installer.mjs"), "export const fixture = true;\n");
  await writeFile(join(source, "LICENSE"), "MIT License\nFixture\n");
  await writeFile(join(source, "README.md"), "Installer fixture\n");
  await writeFile(join(source, ".env"), "SECRET_FIXTURE=do-not-package\n");
  await writeFile(join(source, "test", "never-package.mjs"), "do not package tests\n");
  const armManifest = join(root, "arm64.json");
  const intelManifest = join(root, "x64.json");
  await writeFile(armManifest, JSON.stringify(manifest("arm64")));
  await writeFile(intelManifest, JSON.stringify(manifest("x64")));
  return { root, source, armManifest, intelManifest, output: join(root, "release") };
}

function argsFor(f) {
  return ["--name", "@chat2local-test/installer", "--source-directory", f.source, "--manifest", f.armManifest,
    "--manifest", f.intelManifest, "--output-dir", f.output];
}

test("npm release help describes explicit naming, manifests, and local-only packing", async () => {
  const result = await cli(["--help"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--name/);
  assert.match(result.stdout, /--manifest/);
  assert.match(result.stdout, /not publish/i);
});

test("npm release requires a real npm name and explicit release manifest", async () => {
  for (const args of [[], ["--name", "@OWNER/PACKAGE"], ["--name", "@owner/package"], ["--name", "Bad Name"]]) {
    const result = await cli(args);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /name|placeholder/i);
  }
  const result = await cli(["--name", "chat2local-test-installer"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /manifest/i);
});

test("npm release packs only installer runtime with merged pinned release metadata", async (t) => {
  const f = await fixture(t);
  const result = await cli(argsFor(f));
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.name, "@chat2local-test/installer");
  assert.equal(report.version, "0.3.0");
  assert.equal(report.published, false);
  assert.match(report.archive, /chat2local-test-installer-0\.3\.0\.tgz$/);
  const members = (await execute("tar", ["-tzf", report.archive])).stdout.trim().split("\n").sort();
  assert.deepEqual(members, ["package/LICENSE", "package/README.md", "package/bin/chat2local.mjs", "package/package.json",
    "package/release-manifest.json", "package/src/installer.mjs"].sort());
  const metadata = JSON.parse((await execute("tar", ["-xOf", report.archive, "package/package.json"])).stdout);
  assert.equal(metadata.private, false);
  assert.equal(metadata.name, report.name);
  assert.equal(metadata.version, report.version);
  assert.deepEqual(metadata.repository, { type: "git", url: "git+https://github.com/example/chat2local.git" });
  assert.equal(metadata.scripts, undefined);
  const releasedManifest = JSON.parse((await execute("tar", ["-xOf", report.archive, "package/release-manifest.json"])).stdout);
  assert.deepEqual(releasedManifest, { schemaVersion: 1, version: "0.3.0", assets: [manifest("arm64").assets[0], manifest("x64").assets[0]] });
  assert.equal(JSON.parse(await readFile(join(f.source, "package.json"), "utf8")).private, true,
    "Preparing a public pack must not alter the private draft source package.");
  assert.deepEqual(await readdir(f.output), ["chat2local-test-installer-0.3.0.tgz"]);
});

test("npm release refuses corrupt or duplicate architecture metadata", async (t) => {
  const f = await fixture(t);
  const corrupt = manifest("arm64"); corrupt.assets[0].app.sha256 = "bad";
  await writeFile(f.armManifest, JSON.stringify(corrupt));
  let result = await cli(argsFor(f));
  assert.notEqual(result.code, 0); assert.match(result.stderr, /SHA|digest|manifest/i);
  await writeFile(f.armManifest, JSON.stringify(manifest("arm64")));
  await writeFile(f.intelManifest, JSON.stringify(manifest("arm64")));
  result = await cli(argsFor(f));
  assert.notEqual(result.code, 0); assert.match(result.stderr, /duplicate/i);
});

test("npm release requires matching versions and GitHub repositories", async (t) => {
  const f = await fixture(t);
  await writeFile(f.intelManifest, JSON.stringify(manifest("x64", "example/other-project")));
  let result = await cli(argsFor(f));
  assert.notEqual(result.code, 0); assert.match(result.stderr, /repository/i);
  await writeFile(f.intelManifest, JSON.stringify(manifest("x64", "example/chat2local", "0.4.0")));
  result = await cli(argsFor(f));
  assert.notEqual(result.code, 0); assert.match(result.stderr, /version/i);
});

test("npm release refuses unsafe or incorrectly pinned asset URLs", async (t) => {
  const f = await fixture(t);
  for (const url of ["http://github.com/example/chat2local/releases/download/v0.3.0/chat2local-0.3.0-darwin-arm64.zip",
    "https://secret-key@github.com/example/chat2local/releases/download/v0.3.0/chat2local-0.3.0-darwin-arm64.zip",
    "https://example.com/chat2local.zip", "https://github.com/example/chat2local/releases/download/latest/chat2local.zip"]) {
    const unsafe = manifest("arm64"); unsafe.assets[0].app.url = url;
    await writeFile(f.armManifest, JSON.stringify(unsafe));
    const result = await cli(argsFor(f));
    assert.notEqual(result.code, 0); assert.match(result.stderr, /URL|HTTPS|pinned|GitHub/i);
    assert.doesNotMatch(result.stderr, /secret-key/);
  }
});

test("npm release refuses symlink runtime files and output destinations", async (t) => {
  const f = await fixture(t);
  await rm(join(f.source, "src", "installer.mjs"));
  await symlink("../README.md", join(f.source, "src", "installer.mjs"));
  let result = await cli(argsFor(f));
  assert.notEqual(result.code, 0); assert.match(result.stderr, /symlink/i);
  await rm(join(f.source, "src", "installer.mjs"));
  await writeFile(join(f.source, "src", "installer.mjs"), "export const fixture = true;\n");
  await mkdir(join(f.root, "elsewhere"));
  await symlink(join(f.root, "elsewhere"), f.output);
  result = await cli(argsFor(f));
  assert.notEqual(result.code, 0); assert.match(result.stderr, /symlink/i);
  const inside = argsFor(f); inside[inside.indexOf("--output-dir") + 1] = join(f.source, "dist");
  result = await cli(inside);
  assert.notEqual(result.code, 0); assert.match(result.stderr, /outside/i);
});

test("npm release does not overwrite an existing package archive", async (t) => {
  const f = await fixture(t);
  await mkdir(f.output);
  const existing = join(f.output, "chat2local-test-installer-0.3.0.tgz");
  await writeFile(existing, "existing artifact\n");
  const result = await cli(argsFor(f));
  assert.notEqual(result.code, 0); assert.match(result.stderr, /exists|overwrite/i);
  assert.equal(await readFile(existing, "utf8"), "existing artifact\n");
});
