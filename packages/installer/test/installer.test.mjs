import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink, truncate, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const entry = path.join(packageRoot, 'bin/chat2local.mjs');
const modulePath = new URL('../src/installer.mjs', import.meta.url);
const api = () => import(modulePath);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const asset = (bytes) => ({ url: 'https://github.com/example/local-dev/releases/download/v0.3.0/local-dev.zip', size: bytes.length, sha256: sha(bytes) });
const manifest = (bytes, arch = process.arch) => ({ schemaVersion: 1, version: '0.3.0', assets: [{ platform: 'darwin', arch, app: asset(bytes) }] });
const temporary = async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'local-dev-installer-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

// Independent ZIP fixtures cover names/attributes impossible to obtain from a normal directory.
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name), data = Buffer.from(item.data ?? '');
    const compressed = item.method === 0 ? data : deflateRawSync(data);
    const method = item.method ?? 8;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(item.flags ?? 0x800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(item.claimedSize ?? data.length, 22); local.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(item.flags ?? 0x800, 8); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(item.claimedSize ?? data.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(((item.mode ?? 0o100644) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    const parts = [local, name, compressed]; locals.push(...parts); central.push(directory, name);
    offset += parts.reduce((sum, part) => sum + part.length, 0);
  }
  const centralBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

test('npm exposes an explicit installer command', () => {
  assert.equal(existsSync(entry), true, 'local-dev CLI has not been implemented');
});

test('manifest selects only a matching supported Mac release', async () => {
  const { selectAsset } = await api();
  const bytes = Buffer.from('fixture');
  assert.equal(selectAsset(manifest(bytes, 'arm64'), 'darwin', 'arm64').app.sha256, sha(bytes));
  assert.throws(() => selectAsset(manifest(bytes, 'arm64'), 'linux', 'arm64'), /macOS/);
  assert.throws(() => selectAsset(manifest(bytes, 'arm64'), 'darwin', 'x64'), /No release/);
  assert.throws(() => selectAsset(manifest(bytes, 'arm64'), 'darwin', 'riscv64'), /processor/);
});

test('manifest rejects malformed versions, duplicate routes and unsafe URLs', async () => {
  const { selectAsset } = await api();
  const bytes = Buffer.from('fixture');
  for (const change of [
    (m) => { m.version = '../../escape'; },
    (m) => { m.schemaVersion = 2; },
    (m) => { m.assets.push(m.assets[0]); },
    (m) => { m.assets[0].app.size = Infinity; },
    (m) => { m.assets[0].app.sha256 = 'bad'; },
    (m) => { m.assets[0].app.url = 'http://example.com/app.zip'; },
    (m) => { m.assets[0].app.url = 'https://user:secret@example.com/app.zip'; },
    (m) => { m.assets[0].app.url = 'https://example.com/app.zip#secret'; },
  ]) {
    const data = manifest(bytes, 'arm64'); change(data);
    assert.throws(() => selectAsset(data, 'darwin', 'arm64'), /manifest|HTTPS|credentials|fragment/i);
  }
});

test('artifact hash and byte size are checked before extraction', async (t) => {
  const { verifyArtifact } = await api();
  const directory = await temporary(t), archive = path.join(directory, 'app.zip');
  const bytes = Buffer.from('some bytes'); await writeFile(archive, bytes);
  await verifyArtifact(archive, asset(bytes));
  await assert.rejects(verifyArtifact(archive, { ...asset(bytes), size: bytes.length + 1 }), /size/);
  await assert.rejects(verifyArtifact(archive, { ...asset(bytes), sha256: '0'.repeat(64) }), /SHA-256/);
});

test('HTTPS downloader bounds bytes and refuses insecure redirects', async (t) => {
  const { downloadArtifact } = await api();
  const directory = await temporary(t), target = path.join(directory, 'archive.zip');
  const bytes = Buffer.from('payload');
  await downloadArtifact(asset(bytes), target, { fetchImpl: async () => new Response(bytes) });
  assert.deepEqual(await readFile(target), bytes);
  await assert.rejects(downloadArtifact(asset(bytes), target, { fetchImpl: async () => new Response(Buffer.alloc(bytes.length + 1)) }), /size|limit/);
  await assert.rejects(downloadArtifact(asset(bytes), target, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://example.com/app.zip' } }) }), /HTTPS/);
  await assert.rejects(downloadArtifact(asset(bytes), target, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://user:secret@example.com/app.zip' } }) }), /credentials/);
  await assert.rejects(downloadArtifact(asset(bytes), target, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: '/again' } }) }), /redirect/);
});

test('ZIP extraction preserves normal files and executable permissions', async (t) => {
  const { extractArchive } = await api();
  const directory = await temporary(t), archive = path.join(directory, 'app.zip'), stage = path.join(directory, 'stage');
  await mkdir(stage);
  await writeFile(archive, zip([
    { name: 'Chat2Local.app/', mode: 0o40755 },
    { name: 'Chat2Local.app/Contents/Resources/plain.txt', data: 'Hello', method: 0 },
    { name: 'Chat2Local.app/Contents/MacOS/tool', data: '#!/bin/sh\n', mode: 0o100755 },
  ]));
  await extractArchive(archive, stage);
  assert.equal(await readFile(path.join(stage, 'Chat2Local.app/Contents/Resources/plain.txt'), 'utf8'), 'Hello');
  if (process.platform === 'darwin') assert.equal(spawnSync('/bin/test', ['-x', path.join(stage, 'Chat2Local.app/Contents/MacOS/tool')]).status, 0);
});

test('ZIP directories are normalized so restrictive archive modes cannot block cleanup', async (t) => {
  const { extractArchive } = await api();
  const directory = await temporary(t), archive = path.join(directory, 'app.zip'), stage = path.join(directory, 'stage');
  await mkdir(stage);
  await writeFile(archive, zip([
    { name: 'Chat2Local.app/', mode: 0o040300 },
    { name: 'Chat2Local.app/file.txt', mode: 0o100644, data: 'contents' },
  ]));
  const root = path.join(stage, 'Chat2Local.app');
  let observedMode;
  try { await extractArchive(archive, stage); observedMode = (await stat(root)).mode & 0o777; }
  finally { if (existsSync(root)) await chmod(root, 0o755); }
  assert.equal(observedMode, 0o755, 'Archive directory permissions must not strand staging files');
  assert.equal(await readFile(path.join(root, 'file.txt'), 'utf8'), 'contents');
});

test('lock cleanup runs when staging cleanup fails and preserves the installation error', async (t) => {
  const { cleanupInstall } = await api();
  assert.equal(typeof cleanupInstall, 'function', 'Installer cleanup must handle staging failure separately');
  const directory = await temporary(t), stage = path.join(directory, 'stage'), lock = path.join(directory, 'lock');
  await mkdir(stage); await writeFile(path.join(stage, 'file'), 'held'); await mkdir(lock);
  await chmod(stage, 0o300);
  const original = new Error('Original public verification failure');
  let caught;
  try { await cleanupInstall(stage, lock, original); } catch (error) { caught = error; }
  finally { await chmod(stage, 0o755).catch(() => {}); }
  assert.equal(caught, original);
  assert.equal(existsSync(lock), false, 'Retry lock must be removed even if staging removal fails');
  if (process.getuid?.() !== 0) assert.equal(existsSync(stage), true, 'The fixture must actually fail staging cleanup');
});

test('ZIP extraction rejects traversal, symlinks, duplicates and extra roots before writing', async (t) => {
  const { extractArchive } = await api();
  const directory = await temporary(t);
  const cases = [
    [{ name: 'Chat2Local.app/../../escape', data: 'bad' }],
    [{ name: '/Chat2Local.app/Contents/bad', data: 'bad' }],
    [{ name: 'Chat2Local.app\\Contents\\bad', data: 'bad' }],
    [{ name: 'Chat2Local.app/Contents/link', data: '../../../outside', mode: 0o120777 }],
    [{ name: 'Chat2Local.app/Contents/a', data: 'a' }, { name: 'Chat2Local.app/Contents/a', data: 'b' }],
    [{ name: '__MACOSX/data', data: 'bad' }],
    [{ name: 'Chat2Local.app/Contents/link', data: 'bad', flags: 1 }],
    [{ name: 'Chat2Local.app/Contents/huge', data: 'bad', claimedSize: 0xffffffff }],
    [{ name: 'Chat2Local.app/Contents/file', data: 'a' }, { name: 'Chat2Local.app/Contents/file/child', data: 'b' }],
    [{ name: 'Chat2Local.app/Contents/File', data: 'a' }, { name: 'Chat2Local.app/Contents/file', data: 'b' }],
  ];
  for (let index = 0; index < cases.length; index++) {
    const stage = path.join(directory, `stage-${index}`), archive = path.join(directory, `archive-${index}.zip`);
    await mkdir(stage); await writeFile(archive, zip(cases[index]));
    await assert.rejects(extractArchive(archive, stage), /archive|ZIP|path|symlink|size|duplicate|encrypted/i);
    assert.deepEqual(await readdir(stage), []);
  }
  assert.equal(existsSync(path.join(directory, 'escape')), false);
});

test('ZIP corruption and actual deflate inflation mismatch are rejected', async (t) => {
  const { extractArchive } = await api();
  const directory = await temporary(t), archive = path.join(directory, 'app.zip'), stage = path.join(directory, 'stage');
  await mkdir(stage);
  const bytes = zip([{ name: 'Chat2Local.app/Contents/file', data: 'The real contents' }]);
  bytes[30 + Buffer.byteLength('Chat2Local.app/Contents/file')] ^= 255;
  await writeFile(archive, bytes);
  await assert.rejects(extractArchive(archive, stage), /ZIP|archive|checksum|inflate/i);
});

test('ZIP size is checked before a large archive is loaded into memory', async (t) => {
  const { extractArchive } = await api();
  const directory = await temporary(t), archive = path.join(directory, 'large.zip'), stage = path.join(directory, 'stage');
  await mkdir(stage); await writeFile(archive, ''); await truncate(archive, 513 * 1024 * 1024);
  await assert.rejects(extractArchive(archive, stage), /archive size limit/i);
  assert.deepEqual(await readdir(stage), []);
});

test('CLI help is available without setup and has no lifecycle installation scripts', async () => {
  const result = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /chat2local install/);
  assert.match(result.stdout, /--manifest-file/);
  const config = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(config.bin['chat2local'], 'bin/chat2local.mjs');
  assert.equal(config.private, true);
  assert.equal(config.engines.node, '>=20');
  assert.deepEqual(config.dependencies ?? {}, {});
  for (const hook of ['preinstall', 'install', 'postinstall']) assert.equal(config.scripts?.[hook], undefined);
});

test('CLI errors are actionable and never repeat URL credentials', async () => {
  for (const args of [
    ['install', '--manifest-url', 'http://example.com/manifest.json'],
    ['install', '--manifest-url', 'https://user:SENSITIVE_KEY@example.com/manifest.json'],
    ['install', '--manifest-file', '/missing'],
    ['install', '--destination', 'relative'],
    ['install', '--typo'],
  ]) {
    const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr.includes('SENSITIVE_KEY'), false);
    assert.match(result.stderr, /Chat2Local|chat2local/);
  }
});

test('a failed final rename removes only its empty reservation and allows a retry', async (t) => {
  const { commitApp } = await api();
  assert.equal(typeof commitApp, 'function', 'Atomic app placement needs failure rollback');
  const directory = await temporary(t), target = path.join(directory, 'Chat2Local.app'), staged = path.join(directory, 'stage.app');
  await assert.rejects(commitApp(staged, target), { code: 'ENOENT' });
  assert.equal(existsSync(target), false);
  await mkdir(staged); await writeFile(path.join(staged, 'canary'), 'preserved');
  await commitApp(staged, target);
  assert.equal(await readFile(path.join(target, 'canary'), 'utf8'), 'preserved');
  const another = path.join(directory, 'another.app'); await mkdir(another);
  await assert.rejects(commitApp(another, target), /appeared|destination|existing/i);
  assert.equal(await readFile(path.join(target, 'canary'), 'utf8'), 'preserved');
});

async function signedFixture(directory) {
  const app = path.join(directory, 'Chat2Local.app');
  const resources = path.join(app, 'Contents/Resources');
  await mkdir(resources, { recursive: true }); await mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
  const source = path.join(directory, 'fixture.c'); await writeFile(source, 'int main(void) { return 0; }\n');
  const binary = path.join(app, 'Contents/MacOS/LocalDevMenuBar');
  execFileSync('/usr/bin/clang', [source, '-o', binary]);
  for (const name of ['node', 'tunnel-client']) await writeFile(path.join(resources, name), await readFile(binary), { mode: 0o755 });
  await writeFile(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>LocalDevMenuBar</string>
<key>CFBundleIdentifier</key><string>dev.localdev.localdev</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.3.0</string>
<key>CFBundleVersion</key><string>3</string>
</dict></plist>`);
  for (const file of [path.join(resources, 'node'), path.join(resources, 'tunnel-client'), binary, app]) execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', file], { stdio: 'pipe' });
  const archive = path.join(directory, 'fixture.zip');
  execFileSync('/usr/bin/zip', ['-X', '-q', '-r', archive, 'Chat2Local.app'], { cwd: directory });
  return { app, archive, bytes: await readFile(archive) };
}

test('Mac CLI installs a real signed ZIP, is idempotent and preserves private state', { skip: process.platform !== 'darwin' }, async (t) => {
  const directory = await temporary(t), fixture = await signedFixture(directory), destination = path.join(directory, 'Applications');
  const privateState = path.join(directory, '.local-dev/api-token');
  await mkdir(destination); await mkdir(path.dirname(privateState)); await writeFile(privateState, 'unchanged');
  const manifestPath = path.join(directory, 'release.json'); await writeFile(manifestPath, JSON.stringify(manifest(fixture.bytes)));
  const args = ['install', '--manifest-file', manifestPath, '--archive-file', fixture.archive, '--destination', destination, '--no-open'];
  const first = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Installed/);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(destination, 'Chat2Local.app')]);
  assert.equal(await readFile(privateState, 'utf8'), 'unchanged');
  const second = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr); assert.match(second.stdout, /already installed/);
  assert.equal(await readFile(privateState, 'utf8'), 'unchanged');
  await writeFile(path.join(destination, 'Chat2Local.app/Contents/Info.plist'), 'different unknown existing app');
  const held = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
  assert.notEqual(held.status, 0); assert.match(held.stderr, /already exists|existing/i);
  assert.equal(await readFile(path.join(destination, 'Chat2Local.app/Contents/Info.plist'), 'utf8'), 'different unknown existing app');
  assert.deepEqual((await readdir(destination)).sort(), ['Chat2Local.app']);
});

test('Mac CLI refuses a bad digest, version, symlink destination and unsupported archive', { skip: process.platform !== 'darwin' }, async (t) => {
  const { install } = await api();
  const directory = await temporary(t), fixture = await signedFixture(directory), destination = path.join(directory, 'Applications');
  await mkdir(destination);
  const manifestPath = path.join(directory, 'release.json');
  const data = manifest(fixture.bytes); data.assets[0].app.sha256 = '0'.repeat(64); await writeFile(manifestPath, JSON.stringify(data));
  await assert.rejects(install({ manifestFile: manifestPath, archiveFile: fixture.archive, destination, noOpen: true }), /SHA-256/);
  assert.deepEqual(await readdir(destination), []);
  data.assets[0].app.sha256 = sha(fixture.bytes); data.version = '0.4.0'; await writeFile(manifestPath, JSON.stringify(data));
  await assert.rejects(install({ manifestFile: manifestPath, archiveFile: fixture.archive, destination, noOpen: true }), /version/i);
  assert.deepEqual(await readdir(destination), []);
  await symlink(destination, path.join(directory, 'alias'));
  await assert.rejects(install({ manifestFile: manifestPath, archiveFile: fixture.archive, destination: path.join(directory, 'alias'), noOpen: true }), /symlink/i);
});

test('Mac installer holds a legacy same-bundle app before downloading or creating another service', { skip: process.platform !== 'darwin' }, async (t) => {
  const { install } = await api();
  const directory = await temporary(t), destination = path.join(directory, 'Applications');
  const legacy = path.join(destination, 'Local Dev.app');
  await mkdir(path.join(legacy, 'Contents'), { recursive: true });
  const plist = '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.localdev.localdev</string></dict></plist>';
  await writeFile(path.join(legacy, 'Contents/Info.plist'), plist);
  const manifestPath = path.join(directory, 'release.json');
  await writeFile(manifestPath, JSON.stringify(manifest(Buffer.from('valid manifest, absent archive'))));
  await assert.rejects(install({ manifestFile: manifestPath, archiveFile: path.join(directory, 'absent.zip'), destination, noOpen: true }), /legacy Local Dev\.app.*same application/i);
  assert.equal(await readFile(path.join(legacy, 'Contents/Info.plist'), 'utf8'), plist);
  assert.deepEqual(await readdir(destination), ['Local Dev.app']);
});

test('final app placement rechecks a legacy app created after initial validation', { skip: process.platform !== 'darwin' }, async (t) => {
  const { commitApp } = await api();
  const directory = await temporary(t), legacy = path.join(directory, 'Local Dev.app');
  const staged = path.join(directory, 'stage.app'); await mkdir(staged); await writeFile(path.join(staged, 'canary'), 'held');
  await mkdir(path.join(legacy, 'Contents'), { recursive: true });
  await writeFile(path.join(legacy, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.localdev.localdev</string></dict></plist>');
  await assert.rejects(commitApp(staged, path.join(directory, 'Chat2Local.app')), /legacy Local Dev\.app/i);
  assert.equal(await readFile(path.join(staged, 'canary'), 'utf8'), 'held');
  assert.equal(existsSync(path.join(directory, 'Chat2Local.app')), false);
});

test('npm pack contains only the runnable installer and public release metadata', async (t) => {
  const directory = await temporary(t);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], { cwd: packageRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const packed = JSON.parse(result.stdout)[0];
  const names = packed.files.map((item) => item.path).sort();
  assert.deepEqual(names, ['LICENSE', 'README.md', 'bin/chat2local.mjs', 'package.json', 'release-manifest.json', 'src/installer.mjs']);
  assert.ok(packed.size < 60000);
  assert.equal(names.some((name) => /node_modules|test|api-token|secret|\.env/.test(name)), false);
  if (process.platform === 'darwin') {
    const execution = spawnSync(npm, ['exec', '--yes', '--offline', '--ignore-scripts', '--cache', path.join(directory, 'npm-cache'), '--package', path.join(directory, packed.filename), '--', 'chat2local', '--help'], { encoding: 'utf8' });
    assert.equal(execution.status, 0, execution.stderr);
    assert.match(execution.stdout, /chat2local install/);
  }
});
