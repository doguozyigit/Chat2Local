#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { selectAsset } from "../packages/installer/src/installer.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const runtimeFiles = ["LICENSE", "README.md", "bin/chat2local.mjs", "src/installer.mjs"];
const packedFiles = [...runtimeFiles, "package.json", "release-manifest.json"].sort();
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const npmPartPattern = /^[a-z0-9][a-z0-9._-]*$/;
const placeholderNames = new Set(["@owner/package", "your-package", "@your-scope/your-package", "@example/package"]);

function isInside(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

function validPackageName(name) {
  if (typeof name !== "string" || name.length > 214 || placeholderNames.has(name) || name === "node_modules" || name === "favicon.ico") return false;
  if (name.startsWith("@")) {
    const parts = name.slice(1).split("/");
    return parts.length === 2 && parts.every((part) => npmPartPattern.test(part));
  }
  return npmPartPattern.test(name);
}

function argumentsFor(argv) {
  const options = { name: null, manifests: [], sourceDirectory: join(root, "packages", "installer"),
    outputDirectory: join(root, "dist", "npm-release"), help: false };
  const known = new Map([["--name", "name"], ["--manifest", "manifests"], ["--source-directory", "sourceDirectory"], ["--output-dir", "outputDirectory"]]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") { options.help = true; continue; }
    const key = known.get(argument);
    if (!key) throw new Error("Unknown npm release option. Use --help for inputs.");
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error("An npm release option requires a value.");
    if (key === "manifests") options.manifests.push(resolve(value));
    else options[key] = value;
  }
  if (options.help) return options;
  if (!validPackageName(options.name)) throw new Error("--name must be an explicit, valid lowercase npm package name, without placeholder values.");
  if (options.manifests.length === 0) throw new Error("At least one --manifest FILE is required; hosted releases are never assumed.");
  options.sourceDirectory = resolve(options.sourceDirectory);
  options.outputDirectory = resolve(options.outputDirectory);
  if (isInside(options.sourceDirectory, options.outputDirectory)) throw new Error("The npm release output directory must be outside the installer source.");
  return options;
}

async function sourceFile(source, file) {
  let current = source;
  const segments = file.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    let entry;
    try { entry = await lstat(current); }
    catch { throw new Error(`Installer source is missing required file ${file}.`); }
    if (entry.isSymbolicLink()) throw new Error("Installer source runtime files must not use a symlink.");
    if (index < segments.length - 1 ? !entry.isDirectory() : !entry.isFile() || entry.size === 0) {
      throw new Error(`Installer source does not contain a regular runtime file ${file}.`);
    }
  }
  return current;
}

async function readManifest(path) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 256 * 1024) throw new Error();
    return JSON.parse(await readFile(path, "utf8"));
  } catch { throw new Error("Each release manifest must be a regular JSON file no larger than 256 KiB."); }
}

async function mergeManifests(paths, version) {
  const assets = [];
  const routes = new Set();
  let repository;
  for (const path of paths) {
    const manifest = await readManifest(path);
    if (manifest.version !== version) throw new Error("Release manifest version must match the installer package version.");
    if (!Array.isArray(manifest.assets) || manifest.assets.length < 1) throw new Error("Each release manifest must contain an asset.");
    // Share schema checks with the executable that will consume this manifest.
    selectAsset(manifest, "darwin", manifest.assets[0]?.arch);
    for (const asset of manifest.assets) {
      let url;
      try { url = new URL(asset.app.url); } catch { throw new Error("Release asset URL must be valid HTTPS."); }
      if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) {
        throw new Error("Release asset URL must use credential-free GitHub HTTPS with a pinned version.");
      }
      const segments = url.pathname.split("/").slice(1);
      if (segments.length !== 6) throw new Error("Release asset URL must identify a pinned GitHub release archive.");
      const repo = `${segments[0]}/${segments[1]}`;
      const filename = `chat2local-${version}-darwin-${asset.arch}.zip`;
      if (!repositoryPattern.test(repo) || segments[2] !== "releases" || segments[3] !== "download"
        || segments[4] !== `v${version}` || segments[5] !== encodeURIComponent(filename)) {
        throw new Error("Release asset URL must identify the expected pinned GitHub release archive.");
      }
      if (repository && repository !== repo) throw new Error("All release assets must use the same GitHub repository.");
      repository = repo;
      const route = `${asset.platform}:${asset.arch}`;
      if (routes.has(route)) throw new Error("Release manifests contain a duplicate platform and processor route.");
      routes.add(route);
      assets.push({ platform: asset.platform, arch: asset.arch, app: {
        url: url.href, sha256: asset.app.sha256.toLowerCase(), size: asset.app.size,
      } });
    }
  }
  assets.sort((left, right) => left.arch.localeCompare(right.arch));
  const manifest = { schemaVersion: 1, version, assets };
  for (const asset of assets) selectAsset(manifest, "darwin", asset.arch);
  return { manifest, repository };
}

async function prepare(options) {
  const sourceEntry = await lstat(options.sourceDirectory);
  if (sourceEntry.isSymbolicLink() || !sourceEntry.isDirectory()) throw new Error("Installer source must be a real directory, without a symlink.");
  const source = await realpath(options.sourceDirectory);
  const metadataPath = await sourceFile(source, "package.json");
  const draft = JSON.parse(await readFile(metadataPath, "utf8"));
  if (draft.type !== "module" || draft.bin?.["chat2local"] !== "bin/chat2local.mjs" || typeof draft.version !== "string") {
    throw new Error("Installer source package metadata does not identify the expected executable.");
  }
  if (draft.dependencies && Object.keys(draft.dependencies).length > 0) throw new Error("The standalone installer package must not introduce dependencies.");
  const sourcePaths = new Map();
  for (const file of runtimeFiles) sourcePaths.set(file, await sourceFile(source, file));
  const { manifest, repository } = await mergeManifests(options.manifests, draft.version);
  try {
    const outputEntry = await lstat(options.outputDirectory);
    if (outputEntry.isSymbolicLink() || !outputEntry.isDirectory()) throw new Error("The npm release output must be a real directory, without a symlink.");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(options.outputDirectory, { recursive: true });
  const output = await realpath(options.outputDirectory);
  if (isInside(source, output)) throw new Error("The npm release output directory must resolve outside the installer source.");
  const archiveName = `${options.name.replace(/^@/, "").replace("/", "-")}-${draft.version}.tgz`;
  const archive = join(output, archiveName);
  try { await lstat(archive); throw new Error("The npm package archive already exists; refusing to overwrite it."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = await mkdtemp(join(output, ".npm-release-"));
  try {
    const stage = join(temporary, "package");
    const packed = join(temporary, "packed");
    await mkdir(stage); await mkdir(packed);
    for (const [file, path] of sourcePaths) {
      const destination = join(stage, file);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(path, destination);
      await chmod(destination, file.startsWith("bin/") ? 0o755 : 0o644);
    }
    const metadata = { name: options.name, version: draft.version, private: false,
      description: draft.description ?? "Chat2Local macOS installer", license: draft.license ?? "MIT", type: "module",
      bin: { "chat2local": "bin/chat2local.mjs" }, files: ["bin", "src", "release-manifest.json", "README.md", "LICENSE"],
      engines: draft.engines ?? { node: ">=20" }, os: ["darwin"], cpu: ["arm64", "x64"],
      repository: { type: "git", url: `git+https://github.com/${repository}.git` },
      homepage: `https://github.com/${repository}#readme`, bugs: { url: `https://github.com/${repository}/issues` },
      publishConfig: { access: "public" }, dependencies: {} };
    await writeFile(join(stage, "package.json"), JSON.stringify(metadata, null, 2) + "\n");
    await writeFile(join(stage, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    let packResult;
    try {
      const result = await execute("npm", ["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", packed],
        { cwd: stage, timeout: 60_000, maxBuffer: 256 * 1024 });
      packResult = JSON.parse(result.stdout);
    } catch { throw new Error("npm pack failed. No publication was attempted."); }
    if (!Array.isArray(packResult) || packResult.length !== 1 || packResult[0].filename !== archiveName
      || packResult[0].name !== options.name || packResult[0].version !== draft.version
      || JSON.stringify(packResult[0].files?.map((file) => file.path).sort()) !== JSON.stringify(packedFiles)) {
      throw new Error("npm pack produced an unexpected package inventory or identity.");
    }
    const temporaryArchive = join(packed, archiveName);
    const bytes = await readFile(temporaryArchive);
    await copyFile(temporaryArchive, archive, constants.COPYFILE_EXCL);
    return { name: options.name, version: draft.version, archive, sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length, architectures: manifest.assets.map((asset) => asset.arch), published: false };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

try {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) console.log("Usage: node scripts/prepare-npm-release.mjs --name NPM_PACKAGE_NAME --manifest RELEASE_JSON [--manifest OTHER_RELEASE_JSON] [--output-dir dist/npm-release] [--source-directory packages/installer]\nCombines pinned macOS manifests and creates an npm package archive locally with hooks disabled. Does not publish, upload, or read account credentials.");
  else console.log(JSON.stringify(await prepare(options), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "npm release preparation failed.");
  process.exitCode = 1;
}
