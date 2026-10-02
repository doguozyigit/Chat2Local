#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseLicenseReport } from "./collect-tunnel-licenses.mjs";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const requiredResources = [
  "node", "local-devd.mjs", "tunnel-client", "LICENSE", "THIRD_PARTY_NOTICES.txt",
  "tunnel-client-provenance.json", "local-dev-plugin/scripts/mcp-stdio-bridge.mjs",
  "local-dev-plugin/skills/local-dev/SKILL.md", "licenses/node/LICENSE.txt",
  "licenses/tunnel-client/LICENSE", "licenses/tunnel-client/NOTICE",
  "licenses/dependencies/@modelcontextprotocol/node/LICENSE.txt", "licenses/dependencies/@modelcontextprotocol/server/LICENSE.txt",
  "licenses/dependencies/@modelcontextprotocol/core/LICENSE.txt", "licenses/dependencies/hono/LICENSE.txt",
  "licenses/dependencies/@hono/node-server/LICENSE.txt", "licenses/dependencies/zod/LICENSE.txt",
];
const privateNamePattern = /^(?:\.env(?:\..*)?|api-token|credentials(?:\..*)?|chat-folders\.sqlite(?:-.*)?|\.local-dev|\.local-signing)$/i;
const privateExtensionPattern = /\.(?:pem|key|p12|pfx|keychain(?:-db)?|sqlite(?:3)?|db)$/i;

async function argumentsFor(argv) {
  const options = { app: join(repositoryRoot, "dist", "Chat2Local.app"), outputDirectory: join(repositoryRoot, "dist", "releases"),
    arch: process.arch, repository: null, version: null, help: false };
  const known = new Map([["--app", "app"], ["--output-dir", "outputDirectory"], ["--arch", "arch"],
    ["--repository", "repository"], ["--version", "version"]]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") { options.help = true; continue; }
    const key = known.get(argument);
    if (!key) throw new Error(`Unknown option ${argument}. Use --help for release inputs.`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    options[key] = value;
  }
  if (options.help) return options;
  if (!options.repository) throw new Error("Specify --repository OWNER/REPO for hosted release metadata. No repository is assumed.");
  if (!repositoryPattern.test(options.repository) || options.repository.split("/")[1] === "." || options.repository.split("/")[1] === "..") {
    throw new Error("--repository must be a GitHub OWNER/REPO pair, without a URL or path separators.");
  }
  if (options.arch !== "arm64" && options.arch !== "x64") throw new Error("--arch must be arm64 or x64.");
  if (!options.version) options.version = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")).version;
  if (!versionPattern.test(options.version)) throw new Error("--version must be a semantic release version.");
  options.app = resolve(options.app);
  options.outputDirectory = resolve(options.outputDirectory);
  const outputRelative = relative(options.app, options.outputDirectory);
  if (outputRelative === "" || (!outputRelative.startsWith(`..${sep}`) && outputRelative !== ".." && !outputRelative.startsWith(sep))) {
    throw new Error("The release output directory must be outside the app bundle.");
  }
  return options;
}

async function walkBundle(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("The distribution app bundle must not contain a symlink.");
    if (privateNamePattern.test(entry.name) || privateExtensionPattern.test(entry.name)) {
      throw new Error("The distribution app bundle contains a private runtime or credential file.");
    }
    if (entry.isDirectory()) await walkBundle(path);
    else if (!entry.isFile()) throw new Error("The distribution app bundle contains an unsupported filesystem entry.");
  }
}

async function validateTunnelDependencyLicenses(resources, archiveStem) {
  try {
    const boundedFile = async (path) => {
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0 || entry.size > 1024 * 1024) throw new Error();
      return readFile(path);
    };
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const digestPattern = /^[a-f0-9]{64}$/;
    const report = await boundedFile(join(resources, "licenses", "tunnel-client", `${archiveStem}-licenses.txt`));
    const required = parseLicenseReport(report.toString("utf8"));
    const requiredLicenses = new Map(required.map((entry) => [entry.licenseFile, entry]));
    const requiredModules = new Map(required.map((entry) => [`${entry.module}@${entry.version}`, entry]));
    const directory = join(resources, "licenses", "tunnel-client", "dependencies");
    const index = JSON.parse((await boundedFile(join(directory, "INDEX.json"))).toString("utf8"));
    if (index.schemaVersion !== 1 || index.reportSha256 !== hash(report) || !Array.isArray(index.licenses)
      || index.count !== index.licenses.length || index.count < 1 || index.count > 2000 || !Array.isArray(index.modules)
      || index.modules.length !== requiredModules.size) throw new Error();
    const moduleKeys = new Set();
    for (const entry of index.modules) {
      const key = `${entry.module}@${entry.version}`, expected = requiredModules.get(key);
      if (!expected || moduleKeys.has(key) || entry.sourceURL !== expected.sourceURL || !digestPattern.test(entry.archiveSha256 ?? "")) throw new Error();
      moduleKeys.add(key);
    }
    const licenseKeys = new Set(), expectedFiles = new Set(["INDEX.json"]);
    for (const entry of index.licenses) {
      const module = requiredModules.get(`${entry.module}@${entry.version}`);
      if (!module || entry.sourceURL !== module.sourceURL || typeof entry.relativePath !== "string"
        || !/^[A-Za-z0-9._/-]+$/.test(entry.relativePath) || entry.relativePath.split("/").some((part) => !part || part === "." || part === "..")
        || entry.licenseFile !== `${entry.module}@${entry.version}/${entry.relativePath}` || typeof entry.optionalNotice !== "boolean"
        || licenseKeys.has(entry.licenseFile) || entry.file !== `${hash(entry.licenseFile)}.txt` || expectedFiles.has(entry.file)
        || !digestPattern.test(entry.sha256 ?? "")) throw new Error();
      const expected = requiredLicenses.get(entry.licenseFile);
      if (expected ? entry.optionalNotice || entry.relativePath !== expected.relativePath
        : !entry.optionalNotice || !["NOTICE", "NOTICE.txt", "NOTICE.md"].includes(entry.relativePath)) throw new Error();
      if (hash(await boundedFile(join(directory, entry.file))) !== entry.sha256) throw new Error();
      licenseKeys.add(entry.licenseFile); expectedFiles.add(entry.file);
    }
    if (required.some((entry) => !licenseKeys.has(entry.licenseFile))
      || (await readdir(directory)).some((name) => !expectedFiles.has(name))) throw new Error();
  } catch { throw new Error("The bundled tunnel dependency license index is missing, incomplete, or invalid."); }
}

async function validateBundle(app, options) {
  const appStat = await lstat(app);
  if (appStat.isSymbolicLink() || !appStat.isDirectory()) throw new Error("--app must identify a real app bundle directory, without a symlink.");
  await walkBundle(app);
  const contents = join(app, "Contents");
  let info;
  try {
    const result = await execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(contents, "Info.plist")], { timeout: 10_000 });
    info = JSON.parse(result.stdout);
  } catch { throw new Error("The app bundle Info.plist could not be read."); }
  if (info.CFBundleIdentifier !== "dev.localdev.localdev" || info.CFBundleExecutable !== "LocalDevMenuBar" || info.CFBundlePackageType !== "APPL") {
    throw new Error("The app bundle identifier or executable does not identify Chat2Local.");
  }
  if (info.CFBundleShortVersionString !== options.version) throw new Error("The app bundle version does not match the release version.");
  const resources = join(contents, "Resources");
  let pinnedTunnel;
  try { pinnedTunnel = JSON.parse(await readFile(join(repositoryRoot, "scripts", "tunnel-client-release.json"), "utf8")); }
  catch { throw new Error("The pinned official tunnel-client release metadata could not be read."); }
  const pinnedAsset = pinnedTunnel.assets?.[options.arch];
  const archiveStem = options.arch === "x64" ? `tunnel-client-runtime-v${pinnedTunnel.version}-darwin-amd64` : `tunnel-client-runtime-v${pinnedTunnel.version}-darwin-arm64`;
  const expectedArchiveURL = `https://github.com/openai/tunnel-client/releases/download/v${pinnedTunnel.version}/${archiveStem}.zip`;
  if (pinnedTunnel.upstreamRepository !== "https://github.com/openai/tunnel-client" || !/^\d+\.\d+\.\d+$/.test(pinnedTunnel.version ?? "")
    || pinnedAsset?.url !== expectedArchiveURL || !/^[a-f0-9]{64}$/.test(pinnedAsset?.sha256 ?? "")) {
    throw new Error("The pinned official tunnel-client release metadata is invalid.");
  }
  const architectureResources = [`licenses/tunnel-client/${archiveStem}-licenses.txt`, `licenses/tunnel-client/${archiveStem}.spdx.json`];
  for (const required of [...requiredResources, ...architectureResources]) {
    try {
      const fileStat = await lstat(join(resources, required));
      if (!fileStat.isFile() || fileStat.size === 0) throw new Error();
    } catch { throw new Error(`The app bundle is missing required resource ${required}.`); }
  }
  try {
    const provenance = JSON.parse(await readFile(join(resources, "tunnel-client-provenance.json"), "utf8"));
    if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) throw new Error();
    if (provenance.upstreamRepository !== pinnedTunnel.upstreamRepository || provenance.version !== pinnedTunnel.version
      || provenance.arch !== options.arch || provenance.archiveURL !== pinnedAsset.url || provenance.archiveSha256 !== pinnedAsset.sha256
      || !/^[a-f0-9]{64}$/.test(provenance.binarySha256 ?? "")) throw new Error();
  } catch { throw new Error("The bundled tunnel-client provenance must match the pinned official release and processor."); }
  await validateTunnelDependencyLicenses(resources, archiveStem);
  const expectedArchitecture = options.arch === "x64" ? "x86_64" : "arm64";
  for (const binary of [join(contents, "MacOS", "LocalDevMenuBar"), join(resources, "node"), join(resources, "tunnel-client")]) {
    const fileStat = await lstat(binary);
    if (!fileStat.isFile() || (fileStat.mode & 0o111) === 0) throw new Error("The app bundle contains a missing or non-executable runtime.");
    let architectures;
    try {
      const result = await execute("/usr/bin/lipo", ["-archs", binary], { timeout: 10_000 });
      architectures = result.stdout.trim().split(/\s+/);
    } catch { throw new Error("The app bundle contains a runtime with an unreadable Mach-O architecture."); }
    if (architectures.length !== 1 || architectures[0] !== expectedArchitecture) {
      throw new Error(`Each app runtime architecture must be exactly ${expectedArchitecture}.`);
    }
  }
  // Inspect our executable separately from upstream runtimes, whose own build
  // paths are outside our control. Never echo the matched personal path.
  const appExecutable = await readFile(join(contents, "MacOS", "LocalDevMenuBar"));
  if (/(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+(?=\/)/.test(appExecutable.toString("latin1"))) {
    throw new Error("The app executable contains a personal build path. Strip debugging symbols before signing and packaging.");
  }
  try { await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { timeout: 30_000 }); }
  catch { throw new Error("The app bundle signature failed deep strict verification."); }
}

async function packageRelease(options) {
  if (process.platform !== "darwin") throw new Error("Desktop release archiving requires macOS and its bundle validation tools.");
  await access(options.app);
  const canonicalApp = await realpath(options.app);
  // Validate before taking the snapshot, then validate the complete snapshot again.
  await validateBundle(options.app, options);
  await mkdir(options.outputDirectory, { recursive: true });
  const canonicalOutput = await realpath(options.outputDirectory);
  const outputRelative = relative(canonicalApp, canonicalOutput);
  if (outputRelative === "" || (!outputRelative.startsWith(`..${sep}`) && outputRelative !== ".." && !outputRelative.startsWith(sep))) {
    throw new Error("The release output directory must resolve outside the app bundle.");
  }
  const temporaryDirectory = await mkdtemp(join(canonicalOutput, ".desktop-release-"));
  try {
    const snapshot = join(temporaryDirectory, "Chat2Local.app");
    await cp(options.app, snapshot, { recursive: true, dereference: false, preserveTimestamps: true });
    await validateBundle(snapshot, options);
    const archiveName = `chat2local-${options.version}-darwin-${options.arch}.zip`;
    const manifestName = `release-manifest-darwin-${options.arch}.json`;
    const checksumName = `SHA256SUMS-darwin-${options.arch}.txt`;
    const temporaryArchive = join(temporaryDirectory, archiveName);
    await execute("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--noextattr", "--keepParent", snapshot, temporaryArchive], { timeout: 120_000, maxBuffer: 128 * 1024 });
    const bytes = await readFile(temporaryArchive);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const manifest = { schemaVersion: 1, version: options.version, assets: [{ platform: "darwin", arch: options.arch, app: {
      url: `https://github.com/${options.repository}/releases/download/v${options.version}/${encodeURIComponent(archiveName)}`,
      sha256, size: bytes.length,
    } }] };
    await writeFile(join(temporaryDirectory, manifestName), JSON.stringify(manifest, null, 2) + "\n");
    await writeFile(join(temporaryDirectory, checksumName), `${sha256}  ${archiveName}\n`);
    const outputs = { archive: join(canonicalOutput, archiveName), manifest: join(canonicalOutput, manifestName), checksums: join(canonicalOutput, checksumName) };
    for (const [key, name] of [["archive", archiveName], ["manifest", manifestName], ["checksums", checksumName]]) {
      await rename(join(temporaryDirectory, name), outputs[key]);
    }
    return { ...outputs, version: options.version, platform: "darwin", arch: options.arch, sha256, size: bytes.length };
  } finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
}

try {
  const options = await argumentsFor(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/package-desktop-release.mjs --repository OWNER/REPO [--app 'dist/Chat2Local.app'] [--output-dir dist/releases] [--arch arm64|x64] [--version 0.3.0]\nCreates a verified macOS app ZIP, per-architecture release manifest, and SHA256SUMS. The ZIP includes the bundled tunnel client. No upload or publication is performed.");
  } else console.log(JSON.stringify(await packageRelease(options), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Desktop release packaging failed.");
  process.exitCode = 1;
}
