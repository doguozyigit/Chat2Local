#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024;

async function statIfPresent(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function assetFor(release, arch) {
  if (!["arm64", "x64"].includes(arch)) throw new Error("Unsupported tunnel-client architecture; use arm64 or x64.");
  const asset = release.assets?.[arch];
  if (!asset) throw new Error("No pinned tunnel-client asset for this architecture.");
  const url = new URL(asset.url);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password
    || !url.pathname.startsWith("/openai/tunnel-client/releases/download/") || url.search || url.hash) {
    throw new Error("The pinned tunnel-client URL must use official GitHub HTTPS releases.");
  }
  if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ARCHIVE_BYTES) {
    throw new Error("Invalid pinned tunnel-client checksum or size.");
  }
  if (!/^\d+\.\d+\.\d+$/.test(release.version)) throw new Error("Invalid pinned tunnel-client version.");
  return asset;
}

function requiredEntries(release, arch) {
  const stem = `tunnel-client-runtime-v${release.version}-darwin-${arch === "x64" ? "amd64" : "arm64"}`;
  return ["tunnel-client-runtime", "LICENSE", "NOTICE", `${stem}-licenses.txt`, `${stem}.spdx.json`];
}

// Validate the central and local ZIP headers before invoking the system extractor.
// Pinned archives remain the trust source; the inventory rejects unsafe members.
export function validateArchive(bytes, expected) {
  const invalid = (reason) => { throw new Error(`Invalid tunnel-client archive: ${reason}.`); };
  if (bytes.length < 22) invalid("missing ZIP directory");
  const end = bytes.length - 22;
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 20) !== 0) invalid("unsupported ZIP trailer");
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)
    || bytes.readUInt16LE(end + 8) !== count || count !== expected.length
    || start + size !== end || count === 0xffff) invalid("unexpected or missing entries");
  let cursor = start, total = 0;
  const seen = new Set(), ranges = [];
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) invalid("malformed directory entry");
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20), uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28), extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    if (next > end || bytes.readUInt16LE(cursor + 34) !== 0) invalid("malformed or multi-disk entry");
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameSize), name = nameBytes.toString("utf8");
    if (!expected.includes(name) || !nameBytes.equals(Buffer.from(name)) || seen.has(name)) invalid("unsafe, duplicate or unexpected entry");
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    if ((mode & 0o170000) !== 0o100000) invalid("entry is not a regular file");
    // Bits 1–2 describe DEFLATE compression level; upstream ZIPs use bit 1.
    const allowedFlags = method === 8 ? 0x080e : 0x0808;
    if ((flags & ~allowedFlags) !== 0 || ![0, 8].includes(method)) invalid("encrypted or unsupported entry");
    total += uncompressed;
    if (!uncompressed || total > MAX_PAYLOAD_BYTES) invalid("payload is too large or empty");
    const local = bytes.readUInt32LE(cursor + 42);
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) invalid("malformed local entry");
    const localNameSize = bytes.readUInt16LE(local + 26), localExtraSize = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameSize + localExtraSize, dataEnd = dataStart + compressed;
    if (dataEnd > start || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method
      || !bytes.subarray(local + 30, local + 30 + localNameSize).equals(nameBytes)) invalid("inconsistent local entry");
    if (ranges.some(([from, to]) => local < to && dataEnd > from)) invalid("overlapping entries");
    ranges.push([local, dataEnd]); seen.add(name); cursor = next;
  }
  if (cursor !== end || expected.some((name) => !seen.has(name))) invalid("missing entries");
}

async function download(asset, fetchImpl) {
  const officialURL = (value) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(url.hostname)) {
      throw new Error("Tunnel-client download redirected outside official HTTPS release hosts.");
    }
    return url;
  };
  const signal = AbortSignal.timeout(120_000);
  let current = officialURL(asset.url), response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetchImpl(current.href, { signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === 5) throw new Error("Tunnel-client download has too many redirects or a missing redirect address.");
    current = officialURL(new URL(location, current).href);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Tunnel-client download failed with HTTP ${response.status}.`);
  }
  if (response.url) {
    try { officialURL(response.url); }
    catch (error) {
      await response.body.cancel();
      throw error;
    }
  }
  const declaredSize = response.headers.get("content-length");
  if (declaredSize && Number(declaredSize) !== asset.size) {
    await response.body.cancel(); throw new Error("Tunnel-client download size differs from its pinned size.");
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > asset.size) throw new Error("Tunnel-client download exceeds its pinned size.");
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== asset.size) throw new Error("Tunnel-client download size differs from its pinned size.");
  if (sha256(bytes) !== asset.sha256) throw new Error("Tunnel-client download checksum does not match its release pin.");
  return bytes;
}

async function verifyOutputDirectory(outputDir) {
  const info = await statIfPresent(outputDir);
  if (!info) return;
  if (info.isSymbolicLink()) throw new Error("Tunnel-client output must not be a symbolic link.");
  if (!info.isDirectory()) throw new Error("Tunnel-client output must be a directory.");
  const names = await readdir(outputDir);
  if (!names.length) return;
  if (!names.includes("tunnel-client-provenance.json") || names.some((name) => !["tunnel-client", "licenses", "tunnel-client-provenance.json"].includes(name))) {
    throw new Error("Refusing to replace a directory containing unrelated files.");
  }
  for (const name of names) {
    if ((await lstat(join(outputDir, name))).isSymbolicLink()) throw new Error("Tunnel-client output contains a symbolic link.");
  }
}

export async function prepareTunnelClient({ arch, outputDir, release, fetchImpl = globalThis.fetch }) {
  release ??= JSON.parse(await readFile(new URL("./tunnel-client-release.json", import.meta.url), "utf8"));
  const asset = assetFor(release, arch), expected = requiredEntries(release, arch);
  outputDir = resolve(outputDir ?? join(root, ".tmp", `tunnel-client-${arch}`));
  const cachePath = `${outputDir}.zip`;
  await verifyOutputDirectory(outputDir);
  const cacheInfo = await statIfPresent(cachePath);
  if (cacheInfo?.isSymbolicLink()) throw new Error("Tunnel-client cache must not be a symbolic link.");
  if (cacheInfo && !cacheInfo.isFile()) throw new Error("Tunnel-client cache must be a regular file.");
  let bytes;
  if (cacheInfo?.size === asset.size) {
    const cached = await readFile(cachePath);
    if (sha256(cached) === asset.sha256) bytes = cached;
  }
  bytes ??= await download(asset, fetchImpl);
  validateArchive(bytes, expected);
  await mkdir(dirname(outputDir), { recursive: true });
  const staging = await mkdtemp(join(dirname(outputDir), ".tunnel-client-stage-"));
  const incoming = join(staging, "archive.zip"), extracted = join(staging, "extracted"), prepared = join(staging, "prepared");
  try {
    await writeFile(incoming, bytes, { mode: 0o600, flag: "wx" });
    await mkdir(extracted);
    await execute("/usr/bin/unzip", ["-qq", incoming, "-d", extracted], { timeout: 30_000, maxBuffer: 64 * 1024 });
    const extractedNames = await readdir(extracted);
    if (extractedNames.length !== expected.length || extractedNames.some((name) => !expected.includes(name))) throw new Error("Unexpected extracted tunnel-client archive entry.");
    for (const name of expected) {
      const info = await lstat(join(extracted, name));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Extracted tunnel-client entry is not a regular file.");
    }
    const binarySha256 = sha256(await readFile(join(extracted, "tunnel-client-runtime")));
    await mkdir(join(prepared, "licenses"), { recursive: true });
    await rename(join(extracted, "tunnel-client-runtime"), join(prepared, "tunnel-client"));
    await chmod(join(prepared, "tunnel-client"), 0o755);
    for (const name of expected.filter((name) => name !== "tunnel-client-runtime")) {
      await rename(join(extracted, name), join(prepared, "licenses", name));
      await chmod(join(prepared, "licenses", name), 0o644);
    }
    const provenance = {
      upstreamRepository: release.upstreamRepository, version: release.version, arch,
      archiveURL: asset.url, archiveSha256: asset.sha256, binarySha256,
      packagingChanges: ["renamed tunnel-client-runtime to tunnel-client", "may be signed as part of the Chat2Local macOS app; hashes above describe the original upstream bytes"],
    };
    await writeFile(join(prepared, "tunnel-client-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o644 });
    await verifyOutputDirectory(outputDir);
    const backup = join(staging, "previous");
    if (await statIfPresent(outputDir)) await rename(outputDir, backup);
    try { await rename(prepared, outputDir); }
    catch (error) { if (await statIfPresent(backup)) await rename(backup, outputDir); throw error; }
    // The cache is accepted only after checksum and complete extraction succeed.
    await rename(incoming, cachePath);
    return provenance;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function main(args) {
  let arch = process.arch, outputDir;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help") { process.stdout.write("Usage: node scripts/fetch-tunnel-client.mjs [--arch arm64|x64] [--output-dir DIRECTORY]\nDownloads and checks the pinned OpenAI runtime; never reads account credentials.\n"); return; }
    if (!["--arch", "--output-dir"].includes(arg) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Invalid option: ${arg}.`);
    const value = args[++index];
    if (arg === "--arch") arch = value === "x86_64" ? "x64" : value;
    else outputDir = value;
  }
  process.stdout.write(`${JSON.stringify(await prepareTunnelClient({ arch, outputDir }), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`Tunnel-client preparation failed: ${error.message}\n`); process.exitCode = 1; });
}
