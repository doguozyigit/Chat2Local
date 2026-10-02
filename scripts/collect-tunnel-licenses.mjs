#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MAX_ZIP_BYTES = 32 * 1024 * 1024;
const MAX_LICENSE_BYTES = 1024 * 1024;
const escapeGo = (text) => text.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
const safeRelative = (path) => /^[A-Za-z0-9._/-]+$/.test(path)
  && path.split("/").every((part) => part && part !== "." && part !== "..");

async function info(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function parseLicenseReport(text) {
  if (Buffer.byteLength(text) > MAX_LICENSE_BYTES) throw new Error("License report is too large.");
  const lines = text.split(/\r?\n/), start = lines.indexOf("DEPENDENCY|TYPE|VERSION|LICENSES|LICENSE_FILE|PLATFORMS");
  if (start < 0) throw new Error("License report is missing its dependency table.");
  const licenses = new Map();
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const fields = line.split("|");
    if (fields.length !== 6) throw new Error("Invalid dependency license report row.");
    const licenseFile = fields[4], at = licenseFile.indexOf("@");
    const slash = licenseFile.indexOf("/", at + 1);
    const module = licenseFile.slice(0, at), version = licenseFile.slice(at + 1, slash), relativePath = licenseFile.slice(slash + 1);
    if (at <= 0 || slash < 0 || !safeRelative(module) || !module.includes(".")
      || !/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+incompatible)?$/.test(version)
      || fields[2] !== version || !safeRelative(relativePath)
      || !(fields[0] === module || fields[0].startsWith(`${module}/`))) {
      throw new Error("Invalid module, version or path in dependency license report.");
    }
    const sourceURL = `https://proxy.golang.org/${escapeGo(module)}/@v/${escapeGo(version)}.zip`;
    licenses.set(licenseFile, { licenseFile, module, version, relativePath, sourceURL });
  }
  if (!licenses.size || licenses.size > 500) throw new Error("License report has an unsupported dependency count.");
  return [...licenses.values()].sort((a, b) => a.licenseFile.localeCompare(b.licenseFile, "en"));
}

function checkDownloadURL(text) {
  const url = new URL(text);
  if (url.protocol !== "https:" || url.username || url.password || url.hash
    || !["proxy.golang.org", "storage.googleapis.com"].includes(url.hostname)) {
    throw new Error("Module download must remain on official Go HTTPS redirect hosts.");
  }
  return url.href;
}

async function moduleZip(sourceURL, fetchImpl) {
  const signal = AbortSignal.timeout(120_000);
  let current = sourceURL, response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    checkDownloadURL(current);
    response = await fetchImpl(current, { signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === 5) throw new Error("Invalid or excessive module download redirects.");
    current = checkDownloadURL(new URL(location, current).href);
  }
  if (!response.ok || !response.body) throw new Error(`Module download failed with HTTP ${response.status}.`);
  if (response.url) checkDownloadURL(response.url);
  if (Number(response.headers.get("content-length")) > MAX_ZIP_BYTES) {
    await response.body.cancel(); throw new Error("Module ZIP download is too large.");
  }
  const chunks = [], reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ZIP_BYTES) throw new Error("Module ZIP download exceeds its size limit.");
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks);
}

function zipInventory(bytes, prefix) {
  const invalid = () => { throw new Error("Invalid or duplicate module ZIP archive entry."); };
  let end = -1;
  for (let position = bytes.length - 22; position >= Math.max(0, bytes.length - 65_557); position--) {
    if (bytes.readUInt32LE(position) === 0x06054b50 && position + 22 + bytes.readUInt16LE(position + 20) === bytes.length) { end = position; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) invalid();
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 8) !== count || count >= 50_000 || start + directorySize !== end) invalid();
  const entries = new Map();
  let position = start;
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) invalid();
    const nameSize = bytes.readUInt16LE(position + 28), extraSize = bytes.readUInt16LE(position + 30), commentSize = bytes.readUInt16LE(position + 32);
    const next = position + 46 + nameSize + extraSize + commentSize;
    if (next > end || bytes.readUInt16LE(position + 34)) invalid();
    const rawName = bytes.subarray(position + 46, position + 46 + nameSize), name = rawName.toString("utf8");
    if (!name.startsWith(prefix) || !rawName.equals(Buffer.from(name)) || entries.has(name)) invalid();
    const relative = name.slice(prefix.length).replace(/\/$/, "");
    // Go ZIPs can contain ordinary source filenames with spaces; only selected
    // license paths are passed to unzip. Every member still stays under its module.
    if (!relative || relative.split("/").some((part) => !part || part === "." || part === "..") || relative.includes("\\") || relative.includes("\0")) invalid();
    entries.set(name, { size: bytes.readUInt32LE(position + 24), mode: bytes.readUInt32LE(position + 38) >>> 16 });
    position = next;
  }
  if (position !== end) invalid();
  return entries;
}

async function cachedIndex(outputDir, reportSha256, required) {
  try {
    const indexInfo = await info(join(outputDir, "INDEX.json"));
    if (!indexInfo?.isFile() || indexInfo.isSymbolicLink() || indexInfo.size > MAX_LICENSE_BYTES) return null;
    const index = JSON.parse(await readFile(join(outputDir, "INDEX.json"), "utf8"));
    if (index.schemaVersion !== 1 || index.reportSha256 !== reportSha256 || !Array.isArray(index.licenses)
      || index.count !== index.licenses.length || !Array.isArray(index.modules)) return null;
    if (required.some((entry) => !index.licenses.some((cached) => cached.licenseFile === entry.licenseFile && !cached.optionalNotice))) return null;
    const expectedFiles = new Set(["INDEX.json"]);
    for (const entry of index.licenses) {
      if (!/^[a-f0-9]{64}\.txt$/.test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256)) return null;
      const file = join(outputDir, entry.file), fileInfo = await info(file);
      if (!fileInfo?.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > MAX_LICENSE_BYTES || hash(await readFile(file)) !== entry.sha256) return null;
      expectedFiles.add(entry.file);
    }
    if ((await readdir(outputDir)).some((name) => !expectedFiles.has(name))) return null;
    return index;
  } catch { return null; }
}

async function checkOutput(outputDir) {
  const present = await info(outputDir);
  if (!present) return;
  if (!present.isDirectory() || present.isSymbolicLink()) throw new Error("License output must be a regular directory, not a symbolic link.");
  const names = await readdir(outputDir);
  if (names.some((name) => name !== "INDEX.json" && !/^[a-f0-9]{64}\.txt$/.test(name))
    || (names.length && !names.includes("INDEX.json"))) throw new Error("Refusing to replace unrelated files in license output.");
}

export async function collectTunnelLicenses({ reportPath, outputDir, fetchImpl = globalThis.fetch }) {
  const reportInfo = await info(reportPath);
  if (!reportInfo?.isFile() || reportInfo.isSymbolicLink() || reportInfo.size > MAX_LICENSE_BYTES) throw new Error("Read a regular, bounded dependency license report.");
  const report = await readFile(reportPath), required = parseLicenseReport(report.toString("utf8")), reportSha256 = hash(report);
  outputDir = resolve(outputDir);
  await checkOutput(outputDir);
  const cached = await cachedIndex(outputDir, reportSha256, required);
  if (cached) return cached;
  await mkdir(dirname(outputDir), { recursive: true });
  const staging = await mkdtemp(join(dirname(outputDir), ".tunnel-licenses-stage-"));
  const prepared = join(staging, "prepared");
  await mkdir(prepared);
  const grouped = new Map();
  for (const entry of required) {
    const key = `${entry.module}@${entry.version}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  }
  const groups = [...grouped.values()], modules = [], licenses = [];
  let next = 0;
  try {
    async function worker() {
      while (next < groups.length) {
        const entries = groups[next++], first = entries[0], prefix = `${first.module}@${first.version}/`;
        const bytes = await moduleZip(first.sourceURL, fetchImpl), inventory = zipInventory(bytes, prefix);
        const archivePath = join(staging, `${hash(prefix)}.zip`);
        await writeFile(archivePath, bytes, { mode: 0o600, flag: "wx" });
        const selected = [...entries];
        for (const notice of ["NOTICE", "NOTICE.txt", "NOTICE.md"]) {
          if (inventory.has(`${prefix}${notice}`) && !entries.some((entry) => entry.relativePath === notice)) {
            selected.push({ ...first, relativePath: notice, licenseFile: `${prefix}${notice}`, optionalNotice: true });
          }
        }
        for (const entry of selected) {
          const member = inventory.get(`${prefix}${entry.relativePath}`);
          if (!member || member.size <= 0 || member.size > MAX_LICENSE_BYTES
            || (member.mode && (member.mode & 0o170000) !== 0o100000)) throw new Error(`Missing or invalid dependency license: ${entry.licenseFile}.`);
          const { stdout } = await execute("/usr/bin/unzip", ["-p", archivePath, `${prefix}${entry.relativePath}`], { encoding: "buffer", maxBuffer: MAX_LICENSE_BYTES, timeout: 30_000 });
          if (stdout.length !== member.size) throw new Error(`Incomplete dependency license: ${entry.licenseFile}.`);
          const file = `${hash(entry.licenseFile)}.txt`;
          await writeFile(join(prepared, file), stdout, { mode: 0o644, flag: "wx" });
          licenses.push({ ...entry, file, sha256: hash(stdout), optionalNotice: Boolean(entry.optionalNotice) });
        }
        modules.push({ module: first.module, version: first.version, sourceURL: first.sourceURL, archiveSha256: hash(bytes) });
      }
    }
    const results = await Promise.allSettled(Array.from({ length: Math.min(3, groups.length) }, worker));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    licenses.sort((a, b) => a.licenseFile.localeCompare(b.licenseFile, "en"));
    modules.sort((a, b) => `${a.module}@${a.version}`.localeCompare(`${b.module}@${b.version}`, "en"));
    const index = { schemaVersion: 1, reportSha256, count: licenses.length, modules, licenses };
    await writeFile(join(prepared, "INDEX.json"), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o644 });
    await checkOutput(outputDir);
    const previous = join(staging, "previous");
    if (await info(outputDir)) await rename(outputDir, previous);
    try { await rename(prepared, outputDir); }
    catch (error) { if (await info(previous)) await rename(previous, outputDir); throw error; }
    return index;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help") { process.stdout.write("Usage: node scripts/collect-tunnel-licenses.mjs --report FILE --output-dir DIRECTORY\nCollects full license and copyright text from exact Go module versions.\n"); return; }
    if (!["--report", "--output-dir"].includes(arg) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Invalid option: ${arg}.`);
    options[arg === "--report" ? "reportPath" : "outputDir"] = args[++index];
  }
  if (!options.reportPath || !options.outputDir) throw new Error("Provide --report and --output-dir.");
  const index = await collectTunnelLicenses(options);
  process.stdout.write(`${JSON.stringify({ count: index.count, modules: index.modules.length, outputDir: resolve(options.outputDir) }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`License collection failed: ${error.message}\n`); process.exitCode = 1; });
}
