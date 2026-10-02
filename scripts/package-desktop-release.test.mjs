import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { extractArchive } from "../packages/installer/src/installer.mjs";
import { parseLicenseReport } from "./collect-tunnel-licenses.mjs";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("./package-desktop-release.mjs", import.meta.url));
const macOnly = { skip: process.platform !== "darwin" };
const arch = process.arch === "arm64" ? "arm64" : "x64";
const pinnedTunnel = JSON.parse(await readFile(fileURLToPath(new URL("./tunnel-client-release.json", import.meta.url)), "utf8"));
const upstreamAsset = pinnedTunnel.assets[arch];
const upstreamStem = new URL(upstreamAsset.url).pathname.split("/").at(-1).replace(/\.zip$/, "");
const notices = ["licenses/node/LICENSE.txt", "licenses/tunnel-client/LICENSE", "licenses/tunnel-client/NOTICE",
  `licenses/tunnel-client/${upstreamStem}-licenses.txt`, `licenses/tunnel-client/${upstreamStem}.spdx.json`,
  "licenses/dependencies/@modelcontextprotocol/node/LICENSE.txt", "licenses/dependencies/@modelcontextprotocol/server/LICENSE.txt",
  "licenses/dependencies/@modelcontextprotocol/core/LICENSE.txt", "licenses/dependencies/hono/LICENSE.txt",
  "licenses/dependencies/@hono/node-server/LICENSE.txt", "licenses/dependencies/zod/LICENSE.txt",
  "local-dev-plugin/skills/local-dev/SKILL.md"];
const licenseReport = "DEPENDENCY|TYPE|VERSION|LICENSES|LICENSE_FILE|PLATFORMS\n"
  + "example.com/first|module|v1.0.0|MIT|example.com/first@v1.0.0/LICENSE|darwin\n"
  + "example.com/second|module|v1.0.0|MIT|example.com/second@v1.0.0/LICENSE|darwin\n";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixtureProvenance() {
  return { upstreamRepository: pinnedTunnel.upstreamRepository, version: pinnedTunnel.version, arch,
    archiveURL: upstreamAsset.url, archiveSha256: upstreamAsset.sha256, binarySha256: "a".repeat(64) };
}

async function cli(args) {
  try {
    const result = await execute(process.execPath, [script, ...args], { maxBuffer: 128 * 1024, timeout: 60_000 });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code };
  }
}

async function fixture(t, { identifier = "dev.localdev.localdev", version = "0.3.0", embeddedBuildPath } = {}) {
  const root = await mkdtemp(join(tmpdir(), "local-dev-desktop-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "Chat2Local.app");
  const contents = join(app, "Contents");
  const resources = join(contents, "Resources");
  const binaries = [join(contents, "MacOS", "LocalDevMenuBar"), join(resources, "node"), join(resources, "tunnel-client")];
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(resources, "local-dev-plugin", "scripts"), { recursive: true });
  const source = join(root, "fixture.c");
  await writeFile(source, embeddedBuildPath
    ? `#include <stdio.h>\nint main(void) { puts(${JSON.stringify(embeddedBuildPath)}); return 0; }\n`
    : "int main(void) { return 0; }\n");
  await execute("/usr/bin/clang", ["-arch", arch === "x64" ? "x86_64" : arch, source, "-o", binaries[0]], { timeout: 30_000 });
  for (const binary of binaries.slice(1)) await copyFile(binaries[0], binary);
  for (const binary of binaries) {
    await chmod(binary, 0o755);
    await execute("/usr/bin/codesign", ["--force", "--sign", "-", binary], { timeout: 10_000 });
  }
  await writeFile(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>LocalDevMenuBar</string>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>3</string>
</dict></plist>\n`);
  await writeFile(join(resources, "local-devd.mjs"), "export const fixture = true;\n");
  await writeFile(join(resources, "local-dev-plugin", "scripts", "mcp-stdio-bridge.mjs"), "export const fixture = true;\n");
  await writeFile(join(resources, "LICENSE"), "MIT License\nFixture\n");
  await writeFile(join(resources, "THIRD_PARTY_NOTICES.txt"), "Fixture tunnel client license\n");
  for (const notice of notices) {
    await mkdir(join(resources, notice, ".."), { recursive: true });
    await writeFile(join(resources, notice), "Fixture resource\n");
  }
  const reportPath = join(resources, "licenses", "tunnel-client", `${upstreamStem}-licenses.txt`);
  await writeFile(reportPath, licenseReport);
  const dependencies = join(resources, "licenses", "tunnel-client", "dependencies");
  await mkdir(dependencies);
  const parsedLicenses = parseLicenseReport(licenseReport);
  const licenses = parsedLicenses.map((license) => ({ ...license, file: `${sha(license.licenseFile)}.txt`,
    sha256: sha("Fixture full license text\n"), optionalNotice: false }));
  for (const license of licenses) await writeFile(join(dependencies, license.file), "Fixture full license text\n");
  const index = { schemaVersion: 1, reportSha256: sha(licenseReport), count: licenses.length,
    modules: parsedLicenses.map(({ module, version, sourceURL }) => ({ module, version, sourceURL, archiveSha256: "b".repeat(64) })), licenses };
  const licenseIndex = join(dependencies, "INDEX.json");
  await writeFile(licenseIndex, JSON.stringify(index));
  await writeFile(join(resources, "tunnel-client-provenance.json"), JSON.stringify(fixtureProvenance()) + "\n");
  await execute("/usr/bin/codesign", ["--force", "--sign", "-", app], { timeout: 10_000 });
  return { root, app, resources, output: join(root, "release"), binaries, licenseIndex, dependencies, reportPath };
}

function argsFor(f) {
  return ["--repository", "example/chat2local", "--app", f.app, "--output-dir", f.output, "--arch", arch, "--version", "0.3.0"];
}

test("desktop release help explains the explicit repository and bundle inputs", async () => {
  const result = await cli(["--help"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--repository OWNER\/REPO/);
  assert.match(result.stdout, /--app/);
  assert.match(result.stdout, /--arch/);
});

test("desktop release refuses missing or malformed hosted repository metadata", async () => {
  const missing = await cli([]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /repository/);
  const malformed = await cli(["--repository", "https://github.com/example/chat2local"]);
  assert.notEqual(malformed.code, 0);
  assert.match(malformed.stderr, /OWNER\/REPO/);
});

test("desktop release refuses unsupported target architecture", async () => {
  const result = await cli(["--repository", "example/chat2local", "--arch", "linux"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /arm64.*x64/);
});

test("desktop release rejects version build metadata unsupported by the installer", macOnly, async (t) => {
  const f = await fixture(t, { version: "0.3.0+build" });
  const args = argsFor(f); args[args.indexOf("--version") + 1] = "0.3.0+build";
  const result = await cli(args);
  assert.notEqual(result.code, 0, "The producer must not emit a manifest version that the installer rejects.");
  assert.match(result.stderr, /version/);
});

test("desktop release rejects personal build paths without printing them", macOnly, async (t) => {
  const personalPath = ["", "Users", "release-fixture-person", "Projects", "app"].join("/");
  const f = await fixture(t, { embeddedBuildPath: personalPath });
  const result = await cli(argsFor(f));
  assert.notEqual(result.code, 0, "Personal build paths must not enter a release archive.");
  assert.match(result.stderr, /personal build path/);
  assert.ok(!result.stdout.includes(personalPath));
  assert.ok(!result.stderr.includes(personalPath));
  assert.ok(!result.stderr.includes("release-fixture-person"));
});

test("a signed standalone bundle produces a verifiable ZIP and hosted manifest", macOnly, async (t) => {
  const f = await fixture(t);
  const result = await cli(argsFor(f));
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const archiveName = `chat2local-0.3.0-darwin-${arch}.zip`;
  const archive = join(f.output, archiveName);
  const bytes = await readFile(archive);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const manifest = JSON.parse(await readFile(report.manifest, "utf8"));
  assert.deepEqual(manifest, { schemaVersion: 1, version: "0.3.0", assets: [{ platform: "darwin", arch,
    app: { url: `https://github.com/example/chat2local/releases/download/v0.3.0/${archiveName}`, sha256: digest, size: bytes.length } }] });
  assert.equal(await readFile(report.checksums, "utf8"), `${digest}  ${archiveName}\n`);
  const members = (await execute("/usr/bin/unzip", ["-Z1", archive])).stdout.trim().split("\n");
  assert.ok(members.every((name) => name.startsWith("Chat2Local.app/")), "The archive leaked macOS metadata or another root.");
  assert.ok(members.includes("Chat2Local.app/Contents/Resources/tunnel-client"));
  const extracted = join(f.root, "extracted");
  await mkdir(extracted);
  await execute("/usr/bin/ditto", ["-x", "-k", archive, extracted]);
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", join(extracted, "Chat2Local.app")]);
  assert.equal((await stat(join(extracted, "Chat2Local.app", "Contents", "Resources", "tunnel-client"))).mode & 0o777, 0o755);
  assert.equal((await readFile(join(extracted, "Chat2Local.app", "Contents", "Resources", "tunnel-client"))).equals(await readFile(f.binaries[2])), true);
  const installerStage = join(f.root, "installer-extracted");
  await mkdir(installerStage);
  await extractArchive(archive, installerStage);
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", join(installerStage, "Chat2Local.app")]);
  assert.equal((await readFile(join(installerStage, "Chat2Local.app", "Contents", "Resources", "tunnel-client"))).equals(await readFile(f.binaries[2])), true);
  const prepareScript = fileURLToPath(new URL("./prepare-npm-release.mjs", import.meta.url));
  const npmRelease = await execute(process.execPath, [prepareScript, "--name", "@chat2local-test/fixture-release", "--manifest", report.manifest,
    "--output-dir", join(f.root, "npm-release")], { timeout: 60_000 });
  const prepared = JSON.parse(npmRelease.stdout);
  const packagedManifest = JSON.parse((await execute("tar", ["-xOf", prepared.archive, "package/release-manifest.json"])).stdout);
  assert.deepEqual(packagedManifest, manifest, "The producer's actual manifest must survive npm package preparation unchanged.");
});

test("desktop release holds bundles with a wrong identity or version", macOnly, async (t) => {
  const wrongIdentity = await fixture(t, { identifier: "example.unrelated" });
  const identityResult = await cli(argsFor(wrongIdentity));
  assert.notEqual(identityResult.code, 0);
  assert.match(identityResult.stderr, /identifier/);
  const wrongVersion = await fixture(t, { version: "0.2.0" });
  const versionResult = await cli(argsFor(wrongVersion));
  assert.notEqual(versionResult.code, 0);
  assert.match(versionResult.stderr, /version/);
});

test("desktop release rejects missing tunnel resources and unsigned modifications", macOnly, async (t) => {
  const absent = await fixture(t);
  await rm(join(absent.resources, "tunnel-client"));
  const missing = await cli(argsFor(absent));
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /tunnel-client/);
  const modified = await fixture(t);
  await writeFile(join(modified.resources, "local-devd.mjs"), "changed after signing\n");
  const invalid = await cli(argsFor(modified));
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /signature/);
});

test("desktop release rejects architecture mismatches before archiving", macOnly, async (t) => {
  const f = await fixture(t);
  const wrongArch = arch === "arm64" ? "x64" : "arm64";
  const wrongAsset = pinnedTunnel.assets[wrongArch];
  const wrongStem = new URL(wrongAsset.url).pathname.split("/").at(-1).replace(/\.zip$/, "");
  for (const suffix of ["-licenses.txt", ".spdx.json"]) await writeFile(join(f.resources, "licenses", "tunnel-client", `${wrongStem}${suffix}`), suffix === "-licenses.txt" ? licenseReport : "Fixture resource\n");
  await writeFile(join(f.resources, "tunnel-client-provenance.json"), JSON.stringify({ ...fixtureProvenance(), arch: wrongArch,
    archiveURL: wrongAsset.url, archiveSha256: wrongAsset.sha256 }));
  await execute("/usr/bin/codesign", ["--force", "--sign", "-", f.app]);
  const argumentsForWrongArch = argsFor(f);
  argumentsForWrongArch[argumentsForWrongArch.indexOf("--arch") + 1] = wrongArch;
  const result = await cli(argumentsForWrongArch);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /architecture/);
});

test("desktop release requires the workflow skill and every bundled license notice", macOnly, async (t) => {
  for (const resource of notices) {
    const f = await fixture(t);
    await rm(join(f.resources, resource));
    await execute("/usr/bin/codesign", ["--force", "--sign", "-", f.app]);
    const result = await cli(argsFor(f));
    assert.notEqual(result.code, 0, `Missing ${resource} must hold the distribution.`);
    assert.match(result.stderr, /missing required resource/);
  }
});

test("desktop release requires tunnel provenance to match the pinned official release", macOnly, async (t) => {
  const f = await fixture(t);
  for (const change of [
    (p) => { p.upstreamRepository = "https://github.com/example/unrelated"; },
    (p) => { p.version = "0.0.14"; },
    (p) => { p.arch = arch === "arm64" ? "x64" : "arm64"; },
    (p) => { p.archiveURL = "https://example.com/runtime.zip"; },
    (p) => { p.archiveSha256 = "b".repeat(64); },
    (p) => { p.binarySha256 = "invalid"; },
  ]) {
    const provenance = fixtureProvenance(); change(provenance);
    await writeFile(join(f.resources, "tunnel-client-provenance.json"), JSON.stringify(provenance));
    await execute("/usr/bin/codesign", ["--force", "--sign", "-", f.app]);
    const result = await cli(argsFor(f));
    assert.notEqual(result.code, 0, "Mismatched tunnel provenance must hold the distribution.");
    assert.match(result.stderr, /provenance|pinned official/);
  }
});

test("desktop release requires a dependency license index and complete license text", macOnly, async (t) => {
  const missingIndex = await fixture(t);
  await rm(missingIndex.licenseIndex);
  await execute("/usr/bin/codesign", ["--force", "--sign", "-", missingIndex.app]);
  let result = await cli(argsFor(missingIndex));
  assert.notEqual(result.code, 0); assert.match(result.stderr, /dependency license|INDEX/);
  const missingText = await fixture(t);
  const index = JSON.parse(await readFile(missingText.licenseIndex, "utf8"));
  await rm(join(missingText.dependencies, index.licenses[0].file));
  await execute("/usr/bin/codesign", ["--force", "--sign", "-", missingText.app]);
  result = await cli(argsFor(missingText));
  assert.notEqual(result.code, 0); assert.match(result.stderr, /dependency license/);
});

test("desktop release verifies license text hashes and report coverage", macOnly, async (t) => {
  for (const change of [
    async (f, index) => { await writeFile(join(f.dependencies, index.licenses[0].file), "changed license text\n"); },
    async (_f, index) => { index.reportSha256 = "c".repeat(64); },
    async (_f, index) => { index.licenses.shift(); index.count = index.licenses.length; },
    async (_f, index) => { index.licenses[0].optionalNotice = true; },
    async (_f, index) => { index.licenses[0].module = "example.com/unrelated"; },
  ]) {
    const f = await fixture(t);
    const index = JSON.parse(await readFile(f.licenseIndex, "utf8"));
    await change(f, index);
    await writeFile(f.licenseIndex, JSON.stringify(index));
    await execute("/usr/bin/codesign", ["--force", "--sign", "-", f.app]);
    const result = await cli(argsFor(f));
    assert.notEqual(result.code, 0, "Incomplete or changed dependency notices must hold the distribution.");
    assert.match(result.stderr, /dependency license/);
  }
});

test("desktop release rejects bundle symlinks and private runtime files", macOnly, async (t) => {
  const linked = await fixture(t);
  await symlink("local-devd.mjs", join(linked.resources, "linked-daemon.mjs"));
  const symlinkResult = await cli(argsFor(linked));
  assert.notEqual(symlinkResult.code, 0);
  assert.match(symlinkResult.stderr, /symlink/);
  const privateFile = await fixture(t);
  await writeFile(join(privateFile.resources, "api-token"), "fixture-not-a-real-token\n");
  const privateResult = await cli(argsFor(privateFile));
  assert.notEqual(privateResult.code, 0);
  assert.match(privateResult.stderr, /private/);
  assert.doesNotMatch(privateResult.stderr, /fixture-not-a-real-token/);
});
