#!/usr/bin/env node
// Fetch the official Node.js runtime that ships inside Chat2Local.app.
//
// Why the official distribution instead of the machine's `node`:
// Homebrew's `node` is a thin launcher (~69 KB) that links against
// `@rpath/libnode.<abi>.dylib` and a dozen absolute `/opt/homebrew/...`
// libraries. Bundling just that launcher is what broke Chat2Local: after a
// Homebrew upgrade the referenced `libnode.137.dylib` no longer existed, so the
// daemon died with "Library not loaded" and the tunnel went offline.
//
// The official nodejs.org build is a single self-contained executable that
// links only against Apple system libraries. It is also pinned, so two builds
// of the same commit produce the same runtime regardless of the developer's
// machine.
//
// The download is verified against the upstream SHASUMS256.txt before use.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { architecturesOf, inspectBinary, isSelfContained } from "./macho-deps.mjs";

const execute = promisify(execFile);

/** Pinned runtime. Bump deliberately and re-run the smoke tests. */
export const DEFAULT_NODE_RUNTIME_VERSION = "24.22.1";

const DIST_BASE = "https://nodejs.org/dist";
const MAX_ARCHIVE_BYTES = 260 * 1024 * 1024;
const ARCH_TO_PLATFORM = { arm64: "arm64", x64: "x64" };

export function normalizeVersion(version) {
  const trimmed = String(version ?? "").trim();
  const bare = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  if (!/^\d+\.\d+\.\d+$/.test(bare)) {
    throw new Error(`Invalid Node.js runtime version "${version}"; expected a released version such as 24.22.1.`);
  }
  return bare;
}

export function archiveName(version, arch) {
  const platform = ARCH_TO_PLATFORM[arch];
  if (!platform) throw new Error(`Unsupported architecture "${arch}"; use arm64 or x64.`);
  return `node-v${normalizeVersion(version)}-darwin-${platform}.tar.xz`;
}

export function releaseUrl(version, arch, { checksums = false } = {}) {
  const versionTag = `v${normalizeVersion(version)}`;
  return checksums
    ? `${DIST_BASE}/${versionTag}/SHASUMS256.txt`
    : `${DIST_BASE}/${versionTag}/${archiveName(version, arch)}`;
}

/** Parse SHASUMS256.txt into a filename -> sha256 map. */
export function parseShasums(text) {
  const map = new Map();
  for (const line of String(text).split("\n")) {
    const match = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (match) map.set(match[2], match[1]);
  }
  return map;
}

export function assertPinnedUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "nodejs.org" || parsed.username || parsed.password
    || parsed.search || parsed.hash || !parsed.pathname.startsWith("/dist/")) {
    throw new Error(`The Node.js runtime must come from official nodejs.org HTTPS releases, not "${url}".`);
  }
  return url;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function download(url, destination) {
  assertPinnedUrl(url);
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}) for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error(`Downloaded an empty file from ${url}`);
  await writeFile(destination, bytes);
  return bytes;
}

async function statIfPresent(path) {
  try {
    const { stat } = await import("node:fs/promises");
    return await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Validate that a candidate runtime can be shipped inside the app:
 * correct architecture, self-contained, and actually executable.
 */
export async function validateRuntime(nodePath, { arch, version }) {
  const architecture = await architecturesOf(nodePath);
  if (arch && !architecture.includes(arch)) {
    throw new Error(
      `Bundled Node.js runtime is ${architecture.join("/")} but the app targets ${arch}.`,
    );
  }
  const report = await inspectBinary(nodePath);
  if (!(await isSelfContained(nodePath))) {
    const offenders = report.nonSystem.map((entry) => entry.dependency).join(", ");
    throw new Error(
      `Bundled Node.js runtime is not self-contained; it requires: ${offenders}. `
      + "Ship the official nodejs.org build (scripts/fetch-node-runtime.mjs) instead of a Homebrew launcher.",
    );
  }
  const { stdout } = await execute(nodePath, ["--version"], {
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
  });
  const reported = stdout.trim();
  if (version && reported !== `v${normalizeVersion(version)}`) {
    throw new Error(`Bundled Node.js runtime reports ${reported}; expected v${normalizeVersion(version)}.`);
  }
  return { architecture, version: reported, dependencies: report.dependencies };
}

/**
 * Ensure a verified runtime exists locally and return its details.
 * Cached copies are re-validated so a corrupted cache cannot be shipped.
 */
export async function ensureRuntime({
  arch,
  version = DEFAULT_NODE_RUNTIME_VERSION,
  cacheDir,
  force = false,
  log = () => {},
}) {
  const pinned = normalizeVersion(version);
  const key = `v${pinned}-darwin-${ARCH_TO_PLATFORM[arch] ?? arch}`;
  const runtimeDir = join(cacheDir, key);
  const nodePath = join(runtimeDir, "node");
  const licensePath = join(runtimeDir, "LICENSE");
  const provenancePath = join(runtimeDir, "node-runtime-provenance.json");

  if (!force && (await statIfPresent(provenancePath))) {
    try {
      const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
      const actual = sha256(await readFile(nodePath));
      if (provenance.nodeSha256 === actual && provenance.version === pinned) {
        await validateRuntime(nodePath, { arch, version: pinned });
        log(`Reusing verified Node.js ${provenance.nodeVersion} runtime from cache.`);
        return { nodePath, licensePath, provenance, cached: true };
      }
      log("Cached Node.js runtime failed verification; re-downloading.");
    } catch (error) {
      log(`Cached Node.js runtime is unusable (${error.message}); re-downloading.`);
    }
  }

  const archive = archiveName(pinned, arch);
  const archiveUrl = assertPinnedUrl(releaseUrl(pinned, arch));
  const checksumUrl = assertPinnedUrl(releaseUrl(pinned, arch, { checksums: true }));

  const workDir = await mkdtemp(join(tmpdir(), "chat2local-node-"));
  try {
    log(`Downloading ${archiveUrl}`);
    const archiveBytes = await download(archiveUrl, join(workDir, archive));
    if (archiveBytes.length > MAX_ARCHIVE_BYTES) {
      throw new Error(`Refusing oversized Node.js archive (${archiveBytes.length} bytes).`);
    }

    log("Verifying against the official SHASUMS256.txt");
    const checksumBytes = await download(checksumUrl, join(workDir, "SHASUMS256.txt"));
    const expected = parseShasums(checksumBytes.toString("utf8")).get(archive);
    if (!expected) throw new Error(`No checksum published for ${archive}.`);
    const actual = sha256(archiveBytes);
    if (actual !== expected) {
      throw new Error(`Checksum mismatch for ${archive}: expected ${expected}, got ${actual}.`);
    }

    const extractDir = join(workDir, "extract");
    await mkdir(extractDir, { recursive: true });
    const prefix = `node-v${pinned}-darwin-${ARCH_TO_PLATFORM[arch]}`;
    await execute("tar", [
      "-xJf", join(workDir, archive),
      "-C", extractDir,
      "--strip-components", "1",
      `${prefix}/bin/node`,
      `${prefix}/LICENSE`,
    ], { maxBuffer: 8 * 1024 * 1024 });

    const extractedNode = join(extractDir, "bin", "node");
    const extractedLicense = join(extractDir, "LICENSE");
    const details = await validateRuntime(extractedNode, { arch, version: pinned });

    await mkdir(runtimeDir, { recursive: true });
    await copyFile(extractedNode, nodePath);
    await chmod(nodePath, 0o755);
    await copyFile(extractedLicense, licensePath);

    const provenance = {
      source: archiveUrl,
      checksums: checksumUrl,
      archive,
      archiveSha256: expected,
      version: pinned,
      nodeVersion: details.version,
      architecture: details.architecture,
      nodeSha256: sha256(await readFile(nodePath)),
      dependencies: details.dependencies,
      selfContained: true,
      fetchedAt: new Date().toISOString(),
    };
    await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
    log(`Fetched verified Node.js ${details.version} (${details.architecture.join("/")}).`);
    return { nodePath, licensePath, provenance, cached: false };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = { arch: process.arch === "x64" ? "x64" : "arm64", version: DEFAULT_NODE_RUNTIME_VERSION, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--force") { options.force = true; continue; }
    if (!flag.startsWith("--")) throw new Error(`Unexpected argument "${flag}".`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag}.`);
    index += 1;
    if (flag === "--arch") options.arch = value;
    else if (flag === "--version") options.version = value;
    else if (flag === "--output-dir") options.outputDir = value;
    else if (flag === "--cache-dir") options.cacheDir = value;
    else throw new Error(`Unknown option "${flag}".`);
  }
  if (!options.outputDir) throw new Error("--output-dir is required.");
  if (!options.cacheDir) throw new Error("--cache-dir is required.");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await ensureRuntime({
    arch: options.arch,
    version: options.version,
    cacheDir: options.cacheDir,
    force: options.force,
    log: (message) => console.error(message),
  });
  await mkdir(options.outputDir, { recursive: true });
  const targetNode = join(options.outputDir, "node");
  await copyFile(result.nodePath, targetNode);
  await chmod(targetNode, 0o755);
  await copyFile(result.licensePath, join(options.outputDir, "LICENSE"));
  await copyFile(
    join(result.nodePath, "..", "node-runtime-provenance.json"),
    join(options.outputDir, "node-runtime-provenance.json"),
  );
  console.log(targetNode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`Node.js runtime fetch failed: ${error.message}`);
    process.exit(1);
  });
}
