import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir, release } from 'node:os';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const APP = 'Chat2Local.app';
const BUNDLE_ID = 'dev.localdev.localdev';
const MAX_ARCHIVE = 512 * 1024 * 1024;
const MAX_INFLATED = 1024 * 1024 * 1024;
const MAX_FILE = 256 * 1024 * 1024;
const MAX_MANIFEST = 256 * 1024;
const TIMEOUT = 120000;
const DEFAULT_MANIFEST = fileURLToPath(new URL('../release-manifest.json', import.meta.url));

export const HELP = `Chat2Local installer (macOS, Node.js 20 or later)

Usage: chat2local install [options]

  --manifest-url HTTPS_URL    Use a publisher's HTTPS release manifest
  --manifest-file FILE       Use a local release manifest (requires --archive-file)
  --archive-file FILE        Use a local release ZIP (requires --manifest-file)
  --destination DIRECTORY    Existing absolute installation directory
                              Default: ~/Applications (created if needed)
  --no-open                  Install without launching Chat2Local
  --help                     Show this help

Each published npm package includes its version's public release manifest.
The source draft stays unconfigured until release metadata is supplied.
Installation is explicit; npm install does not launch or download anything.
Existing apps are never replaced.
`;

function fail(message) {
  const error = new Error(message);
  error.publicMessage = message;
  return error;
}

export function parseArguments(argv) {
  if (argv.length === 0 || (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0]))) return { help: true };
  if (argv[0] !== 'install') throw fail('Use "chat2local install" or "chat2local --help".');
  const options = {};
  const values = new Map([['--manifest-url', 'manifestUrl'], ['--manifest-file', 'manifestFile'], ['--archive-file', 'archiveFile'], ['--destination', 'destination']]);
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--no-open') options.noOpen = true;
    else if (values.has(argument)) {
      const key = values.get(argument), value = argv[++index];
      if (!value || value.startsWith('--') || options[key]) throw fail('An installer option is missing its value or was repeated. See "chat2local --help".');
      options[key] = value;
    } else throw fail('Unknown installer option. See "chat2local --help".');
  }
  if (options.manifestUrl && options.manifestFile) throw fail('Choose either --manifest-url or --manifest-file.');
  if (Boolean(options.manifestFile) !== Boolean(options.archiveFile)) throw fail('Local validation requires both --manifest-file and --archive-file.');
  if (options.manifestUrl) safeHttpsUrl(options.manifestUrl);
  if (options.destination && !path.isAbsolute(options.destination)) throw fail('The installation destination must be an absolute directory.');
  return options;
}

function safeHttpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('The release manifest must use a valid HTTPS URL.'); }
  if (url.protocol !== 'https:') throw fail('Release downloads must use HTTPS.');
  if (url.username || url.password) throw fail('Release URLs must not contain credentials.');
  if (url.hash) throw fail('Release URLs must not contain a fragment.');
  return url;
}

export function selectAsset(manifest, platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin') throw fail('Chat2Local requires macOS 14 or later.');
  if (!['arm64', 'x64'].includes(arch)) throw fail('This Mac processor is not supported.');
  if (!manifest || manifest.schemaVersion !== 1 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? '') || !Array.isArray(manifest.assets) || manifest.assets.length > 20) throw fail('The release manifest is invalid or unsupported.');
  const routes = new Set();
  for (const item of manifest.assets) {
    if (!item || item.platform !== 'darwin' || !['arm64', 'x64'].includes(item.arch) || !item.app || !Number.isSafeInteger(item.app.size) || item.app.size < 1 || item.app.size > MAX_ARCHIVE || !/^[a-f0-9]{64}$/i.test(item.app.sha256 ?? '') || typeof item.app.url !== 'string') throw fail('The release manifest contains an invalid asset.');
    safeHttpsUrl(item.app.url);
    const route = `${item.platform}:${item.arch}`;
    if (routes.has(route)) throw fail('The release manifest contains duplicate processor releases.');
    routes.add(route);
  }
  const selected = manifest.assets.find((item) => item.platform === platform && item.arch === arch);
  if (!selected) throw fail('No release is configured for this Mac. The private npm preview needs a published manifest; see the installation guide or use local validation options.');
  return selected;
}

async function fetchBounded(url, maxBytes, { fetchImpl = globalThis.fetch, timeout = TIMEOUT } = {}) {
  let current = safeHttpsUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    for (let attempt = 0; attempt <= 5; attempt++) {
      const response = await fetchImpl(current.href, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'Chat2LocalInstaller/0.3.0', Accept: 'application/octet-stream' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (attempt === 5 || !location) throw fail('Too many release download redirects or a missing redirect address.');
        let next;
        try { next = new URL(location, current); } catch { throw fail('The release download redirect is invalid.'); }
        current = safeHttpsUrl(next.href);
        continue;
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw fail('The release download was unavailable. Check the publisher release and try again.'); }
      const contentLength = response.headers.get('content-length');
      if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) { await response.body.cancel(); throw fail('The release download exceeds its size limit.'); }
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.byteLength;
        if (length > maxBytes) { controller.abort(); throw fail('The release download exceeds its size limit.'); }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks, length);
    }
    throw fail('Too many release download redirects.');
  } catch (error) {
    if (error.publicMessage) throw error;
    throw fail('The HTTPS release download failed or timed out. Check the network and retry.');
  } finally { clearTimeout(timer); }
}

export async function downloadArtifact(asset, output, options = {}) {
  const bytes = await fetchBounded(asset.url, Math.min(MAX_ARCHIVE, asset.size), options);
  if (bytes.length !== asset.size) throw fail('The release archive size does not match its manifest.');
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256.toLowerCase()) throw fail('The release archive SHA-256 does not match its manifest.');
  await writeFile(output, bytes, { mode: 0o600 });
}

export async function verifyArtifact(file, asset) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw fail('The release archive must be a regular file.');
  if (info.size !== asset.size || info.size > MAX_ARCHIVE) throw fail('The release archive size does not match its manifest.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== asset.sha256.toLowerCase()) throw fail('The release archive SHA-256 does not match its manifest.');
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  crcTable[index] = value >>> 0;
}
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}

function archiveEntries(bytes) {
  const invalid = () => fail('The ZIP archive is invalid, unsupported, or contains unsafe paths.');
  if (bytes.length < 22 || bytes.length > MAX_ARCHIVE) throw invalid();
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end === -1 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw invalid();
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (!count || count > 20000 || count === 0xffff || bytes.readUInt16LE(end + 8) !== count || start + size !== end) throw invalid();
  const entries = [], names = new Map(), intervals = [];
  let offset = start, inflated = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw invalid();
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), checksum = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20), uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const external = bytes.readUInt32LE(offset + 38), localOffset = bytes.readUInt32LE(offset + 42);
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > end || (flags & 1) || (flags & ~(0x800 | 8 | 2 | 4)) || ![0, 8].includes(method) || uncompressedSize > MAX_FILE || compressedSize === 0xffffffff || localOffset === 0xffffffff || bytes.readUInt16LE(offset + 34)) throw invalid();
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    let name;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(rawName); } catch { throw invalid(); }
    if (!name || name.length > 1024 || /[\\\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || !name.startsWith(`${APP}/`)) throw invalid();
    const directory = name.endsWith('/'), parts = name.replace(/\/$/, '').split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) throw invalid();
    const type = (external >>> 16) & 0o170000;
    if (![0, 0o040000, 0o100000].includes(type) || (directory && type === 0o100000) || (!directory && type === 0o040000) || (directory && uncompressedSize)) throw fail('The ZIP archive contains a symlink or unsupported file type.');
    const normalized = parts.join('/'), key = normalized.normalize('NFD').toLowerCase();
    if (names.has(key)) throw fail('The ZIP archive contains duplicate paths.');
    names.set(key, { directory, parts });
    inflated += uncompressedSize;
    if (inflated > MAX_INFLATED) throw fail('The ZIP archive exceeds its expanded size limit.');
    if (localOffset + 30 > start || bytes.readUInt32LE(localOffset) !== 0x04034b50 || bytes.readUInt16LE(localOffset + 6) !== flags || bytes.readUInt16LE(localOffset + 8) !== method) throw invalid();
    const localNameLength = bytes.readUInt16LE(localOffset + 26), localExtra = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtra, dataEnd = dataStart + compressedSize;
    if (dataEnd > start || localNameLength !== rawName.length || !bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(rawName)) throw invalid();
    if (!(flags & 8) && (bytes.readUInt32LE(localOffset + 14) !== checksum || bytes.readUInt32LE(localOffset + 18) !== compressedSize || bytes.readUInt32LE(localOffset + 22) !== uncompressedSize)) throw invalid();
    intervals.push([localOffset, dataEnd]);
    entries.push({ name: normalized, directory, mode: ((external >>> 16) & 0o777) || (directory ? 0o755 : 0o644), method, checksum, uncompressedSize, dataStart, dataEnd });
    offset = recordEnd;
  }
  if (offset !== end) throw invalid();
  intervals.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < intervals.length; index++) if (intervals[index][0] < intervals[index - 1][1]) throw invalid();
  for (const { parts } of names.values()) {
    for (let index = 1; index < parts.length; index++) {
      const parent = names.get(parts.slice(0, index).join('/').normalize('NFD').toLowerCase());
      if (parent && !parent.directory) throw invalid();
    }
  }
  return entries;
}

export async function extractArchive(archive, destination) {
  const info = await lstat(destination);
  if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(destination)).length) throw fail('ZIP extraction requires a new, empty staging directory.');
  const archiveInfo = await lstat(archive);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) throw fail('The ZIP archive must be a regular file.');
  if (archiveInfo.size > MAX_ARCHIVE) throw fail('The ZIP archive size limit was exceeded.');
  const bytes = await readFile(archive), entries = archiveEntries(bytes);
  for (const item of entries) {
    const target = path.join(destination, item.name);
    if (item.directory) {
      // An archive may omit owner read/write bits. Staging must remain inspectable
      // and removable; directory modes are not needed to execute the application.
      await mkdir(target, { recursive: true, mode: 0o755 });
      await chmod(target, 0o755);
      continue;
    }
    let contents;
    try {
      const compressed = bytes.subarray(item.dataStart, item.dataEnd);
      contents = item.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, item.uncompressedSize) });
    } catch { throw fail('The ZIP archive could not be inflated safely.'); }
    if (contents.length !== item.uncompressedSize || crc32(contents) !== item.checksum) throw fail('The ZIP archive failed its file size or checksum validation.');
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, contents, { flag: 'wx', mode: item.mode });
    await chmod(target, item.mode);
  }
  return path.join(destination, APP);
}

async function validateApp(app, version, arch) {
  try {
    const plist = path.join(app, 'Contents/Info.plist');
    const getKey = async (key) => (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { timeout: 10000 })).stdout.trim();
    if (await getKey('CFBundleIdentifier') !== BUNDLE_ID || await getKey('CFBundleExecutable') !== 'LocalDevMenuBar' || await getKey('CFBundlePackageType') !== 'APPL') throw fail('The release archive is not a Chat2Local application.');
    if (await getKey('CFBundleShortVersionString') !== version) throw fail('The Chat2Local application version does not match its release manifest.');
    for (const relative of ['Contents/MacOS/LocalDevMenuBar', 'Contents/Resources/node', 'Contents/Resources/tunnel-client']) {
      const binary = path.join(app, relative), info = await lstat(binary);
      if (!info.isFile() || info.isSymbolicLink() || !(info.mode & 0o111)) throw fail('The Chat2Local release is missing an executable component.');
      const architectures = (await run('/usr/bin/lipo', ['-archs', binary], { timeout: 10000 })).stdout.trim().split(/\s+/);
      if (!architectures.includes(arch === 'x64' ? 'x86_64' : 'arm64')) throw fail('The Chat2Local release contains a component for the wrong Mac processor.');
    }
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 30000 });
  } catch (error) {
    if (error.publicMessage) throw error;
    throw fail('The Chat2Local release failed its bundle or code signature verification.');
  }
}

async function fingerprint(directory) {
  const hash = createHash('sha256');
  const visit = async (relative) => {
    const full = path.join(directory, relative), info = await lstat(full);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw fail('An existing application contains unsupported files.');
    hash.update(`${relative}\0${info.isDirectory() ? 'd' : 'f'}\0${info.mode & 0o777}\0`);
    if (info.isDirectory()) for (const name of (await readdir(full)).sort()) await visit(path.join(relative, name));
    else for await (const chunk of createReadStream(full)) hash.update(chunk);
  };
  await visit('');
  return hash.digest('hex');
}

async function existingInfo(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function assertNoLegacyApp(destination) {
  const legacy = path.join(destination, 'Local Dev.app');
  const entry = await existingInfo(legacy);
  if (!entry) return;
  // The renamed app shares its service, private state and bundle identity with
  // Local Dev. Installing both copies can start competing services.
  const held = () => fail('A legacy Local Dev.app occupies this destination and may be the same application. Close it and move it aside before installing Chat2Local; it was not changed.');
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw held();
  let identifier;
  try {
    const plist = path.join(legacy, 'Contents/Info.plist');
    const info = await lstat(plist);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST) throw held();
    identifier = (await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { timeout: 10000 })).stdout.trim();
  } catch { throw held(); }
  if (identifier === BUNDLE_ID) throw held();
}

export async function commitApp(stagedApp, target) {
  await assertNoLegacyApp(path.dirname(target));
  // Reserve exclusively so neither an unknown app nor another installer is replaced.
  try { await mkdir(target, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw fail('An application appeared at the destination during installation. It was not changed.');
    throw error;
  }
  const reservation = await lstat(target);
  try { await rename(stagedApp, target); }
  catch (error) {
    const current = await existingInfo(target);
    if (current?.ino === reservation.ino && current.dev === reservation.dev) await rmdir(target).catch(() => {});
    throw error;
  }
}

export async function cleanupInstall(stage, lock, originalError) {
  let cleanupFailed = false;
  try {
    if (stage) await rm(stage, { recursive: true, force: true });
  } catch { cleanupFailed = true; }
  finally {
    try { await rm(lock, { recursive: true, force: true }); }
    catch { cleanupFailed = true; }
  }
  if (originalError) throw originalError;
  if (cleanupFailed) throw fail('Installation cleanup could not finish. Inspect the temporary installer folders in the destination before retrying.');
}

export async function install(options = {}) {
  if (process.platform !== 'darwin' || Number(release().split('.')[0]) < 23) throw fail('Chat2Local requires macOS 14 or later.');
  if (Number(process.versions.node.split('.')[0]) < 20) throw fail('The installer requires Node.js 20 or later.');
  if (options.manifestUrl && options.manifestFile) throw fail('Choose either --manifest-url or --manifest-file.');
  if (Boolean(options.manifestFile) !== Boolean(options.archiveFile)) throw fail('Local validation requires both --manifest-file and --archive-file.');
  let manifestBytes;
  if (options.manifestUrl) manifestBytes = await fetchBounded(options.manifestUrl, MAX_MANIFEST);
  else {
    const file = options.manifestFile ?? DEFAULT_MANIFEST, info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST) throw fail('The release manifest must be a small regular JSON file.');
    manifestBytes = await readFile(file);
  }
  let manifest;
  try { manifest = JSON.parse(manifestBytes); } catch { throw fail('The release manifest is not valid JSON.'); }
  const selected = selectAsset(manifest);
  const requested = options.destination ?? path.join(homedir(), 'Applications');
  if (!path.isAbsolute(requested)) throw fail('The installation destination must be an absolute directory.');
  if (!options.destination) await mkdir(requested, { recursive: true, mode: 0o755 });
  const requestedInfo = await lstat(requested);
  if (requestedInfo.isSymbolicLink()) throw fail('The installation destination cannot be a symlink.');
  if (!requestedInfo.isDirectory()) throw fail('The installation destination must be an existing directory.');
  const destination = await realpath(requested), target = path.join(destination, APP), lock = path.join(destination, '.local-dev-install.lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') throw fail('Another Chat2Local installer may be running. Inspect the destination before retrying.'); throw error; }
  let stage, installationError;
  try {
    // Hold before downloading, then check again during final placement while
    // using the same installation lock as releases under the previous name.
    await assertNoLegacyApp(destination);
    stage = await mkdtemp(path.join(destination, '.local-dev-install-'));
    const archive = path.join(stage, 'release.zip');
    if (options.archiveFile) {
      await verifyArtifact(options.archiveFile, selected.app);
      await copyFile(options.archiveFile, archive);
      await verifyArtifact(archive, selected.app);
    } else await downloadArtifact(selected.app, archive);
    const extraction = path.join(stage, 'extracted'); await mkdir(extraction, { mode: 0o700 });
    const stagedApp = await extractArchive(archive, extraction);
    await validateApp(stagedApp, manifest.version, process.arch);
    const before = await existingInfo(target);
    let existing = false;
    if (before) {
      if (!before.isDirectory() || before.isSymbolicLink()) throw fail('An existing Chat2Local.app already occupies this destination. It was not changed.');
      let same = false;
      try { same = await fingerprint(target) === await fingerprint(stagedApp); } catch { /* Hold unknown existing apps. */ }
      if (!same) throw fail('An existing Chat2Local.app already occupies this destination. Close it and move it aside before installing another release; it was not changed.');
      await validateApp(target, manifest.version, process.arch);
      existing = true;
    } else {
      await commitApp(stagedApp, target);
    }
    if (!options.noOpen) {
      try { await run('/usr/bin/open', [target], { timeout: 15000 }); }
      catch { throw fail('Chat2Local was installed, but could not be opened. Open it from your Applications folder.'); }
    }
    return { path: target, version: manifest.version, existing };
  } catch (error) { installationError = error; throw error; }
  finally { await cleanupInstall(stage, lock, installationError); }
}
