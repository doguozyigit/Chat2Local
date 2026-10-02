import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

const moduleURL = new URL("./fetch-tunnel-client.mjs", import.meta.url);
const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Stored ZIP fixtures exercise the real archive validator and system extractor.
function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const { name, contents = "fixture", mode = 0o100644, deflated = false } of entries) {
    const path = Buffer.from(name), bytes = Buffer.from(contents);
    const compressed = deflated ? deflateRawSync(bytes, { level: 9 }) : bytes;
    const method = deflated ? 8 : 0, flags = deflated ? 2 : 0;
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6); header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(path.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4);
    record.writeUInt16LE(20, 6); record.writeUInt16LE(flags, 8); record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(path.length, 28); record.writeUInt32LE((mode << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    local.push(header, path, compressed); central.push(record, path);
    offset += header.length + path.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function payload() {
  return [
    { name: "tunnel-client-runtime", contents: "#!/bin/sh\nprintf fixture\n", mode: 0o100755 },
    { name: "LICENSE", contents: "Fixture Apache license\n" },
    { name: "NOTICE", contents: "Fixture copyright notice\n" },
    { name: "tunnel-client-runtime-v0.0.15-darwin-arm64-licenses.txt", contents: "Fixture dependency licenses\n" },
    { name: "tunnel-client-runtime-v0.0.15-darwin-arm64.spdx.json", contents: "{\"spdxVersion\":\"SPDX-2.3\"}\n" },
  ];
}

async function setup(t, entries = payload()) {
  const root = await mkdtemp(join(tmpdir(), "local-dev-tunnel-fetch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = zip(entries), outputDir = join(root, "runtime");
  const release = {
    upstreamRepository: "https://github.com/openai/tunnel-client", version: "0.0.15",
    assets: { arm64: { url: "https://github.com/openai/tunnel-client/releases/download/v0.0.15/tunnel-client-runtime-v0.0.15-darwin-arm64.zip", sha256: checksum(bytes), size: bytes.length } },
  };
  let downloads = 0;
  const fetchImpl = async () => { downloads++; return new Response(bytes); };
  return { root, bytes, outputDir, release, fetchImpl, downloads: () => downloads };
}

async function fetcher() {
  try { return (await import(moduleURL)).prepareTunnelClient; }
  catch (error) { assert.fail(`The pinned tunnel downloader must exist: ${error.code ?? error.message}`); }
}

test("verified runtime extraction preserves notices and records original hashes", async (t) => {
  const f = await setup(t), prepare = await fetcher();
  const result = await prepare({ ...f, arch: "arm64" });
  assert.equal(f.downloads(), 1);
  assert.equal(await readFile(join(f.outputDir, "tunnel-client"), "utf8"), payload()[0].contents);
  assert.equal(await readFile(join(f.outputDir, "licenses", "LICENSE"), "utf8"), payload()[1].contents);
  assert.equal(await readFile(join(f.outputDir, "licenses", "NOTICE"), "utf8"), payload()[2].contents);
  assert.equal((await readdir(join(f.outputDir, "licenses"))).length, 4);
  const provenance = JSON.parse(await readFile(join(f.outputDir, "tunnel-client-provenance.json"), "utf8"));
  assert.equal(provenance.archiveSha256, checksum(f.bytes));
  assert.equal(provenance.binarySha256, checksum(Buffer.from(payload()[0].contents)));
  assert.equal(provenance.arch, "arm64");
  assert.equal(provenance.version, "0.0.15");
  assert.deepEqual(result, provenance);
  assert.ok(provenance.packagingChanges.some((change) => change.includes("renamed")));
});

test("cached ZIP is rechecked and reused without a network request", async (t) => {
  const f = await setup(t), prepare = await fetcher();
  await prepare({ ...f, arch: "arm64" });
  await prepare({ ...f, arch: "arm64", fetchImpl: () => assert.fail("Verified cache must avoid downloading") });
  assert.equal(f.downloads(), 1);
});

test("upstream maximum-compression ZIP flags remain compatible with extraction", async (t) => {
  const f = await setup(t, payload().map((entry) => ({ ...entry, deflated: true }))), prepare = await fetcher();
  await prepare({ ...f, arch: "arm64" });
  assert.equal(await readFile(join(f.outputDir, "tunnel-client"), "utf8"), payload()[0].contents);
});

test("corrupt cache is replaced only by a newly verified download", async (t) => {
  const f = await setup(t), prepare = await fetcher();
  await writeFile(`${f.outputDir}.zip`, "corrupt");
  await prepare({ ...f, arch: "arm64" });
  assert.equal(f.downloads(), 1);
  assert.equal(checksum(await readFile(`${f.outputDir}.zip`)), checksum(f.bytes));
});

test("download checksum mismatch creates no runtime or accepted cache", async (t) => {
  const f = await setup(t), prepare = await fetcher();
  f.release.assets.arm64.sha256 = "a".repeat(64);
  await assert.rejects(prepare({ ...f, arch: "arm64" }), /checksum/i);
  assert.deepEqual(await readdir(f.root), []);
});

test("downloads cannot exceed their pinned size", async (t) => {
  const f = await setup(t), prepare = await fetcher();
  await assert.rejects(prepare({ ...f, arch: "arm64", fetchImpl: async () => new Response(Buffer.concat([f.bytes, Buffer.from("extra")])) }), /size|large/i);
  assert.deepEqual(await readdir(f.root), []);
});

test("verified archives reject traversal, symlinks, duplicate or unexpected entries", async (t) => {
  const prepare = await fetcher();
  for (const entry of [
    { name: "../outside", contents: "escape" },
    { name: "unknown-file", contents: "unexpected" },
    { name: "tunnel-client-runtime", contents: "duplicate" },
    { name: "NOTICE", contents: "../outside", mode: 0o120777 },
  ]) {
    const base = payload();
    if (entry.mode) base.splice(2, 1);
    const f = await setup(t, [...base, entry]);
    await assert.rejects(prepare({ ...f, arch: "arm64" }), /archive|entry|regular|duplicate|unsafe/i);
    assert.ok(!(await readdir(f.root)).includes("runtime"));
  }
});

test("incomplete archives and symlinked output/cache paths cannot install", async (t) => {
  const prepare = await fetcher();
  const f = await setup(t, payload().slice(0, 4));
  await assert.rejects(prepare({ ...f, arch: "arm64" }), /archive|missing/i);
  const valid = await setup(t);
  const elsewhere = join(valid.root, "elsewhere");
  await mkdir(elsewhere);
  await symlink(elsewhere, valid.outputDir);
  await assert.rejects(prepare({ ...valid, arch: "arm64" }), /symbolic|symlink/i);
  assert.deepEqual(await readdir(elsewhere), []);
  await rm(valid.outputDir);
  await writeFile(join(elsewhere, "zip"), valid.bytes);
  await symlink(join(elsewhere, "zip"), `${valid.outputDir}.zip`);
  await assert.rejects(prepare({ ...valid, arch: "arm64" }), /symbolic|symlink/i);
});

test("unsupported architecture and insecure download URLs fail before network activity", async (t) => {
  const f = await setup(t), prepare = await fetcher();
  await assert.rejects(prepare({ ...f, arch: "ia32" }), /architecture|arch/i);
  f.release.assets.arm64.url = "http://github.com/openai/tunnel-client/releases/download/v0.0.15/runtime.zip";
  await assert.rejects(prepare({ ...f, arch: "arm64" }), /HTTPS|URL/i);
  assert.equal(f.downloads(), 0);
});

test("official HTTPS redirects are followed explicitly with a bounded request chain", async (t) => {
  const f = await setup(t), prepare = await fetcher(), requests = [];
  const redirectURL = "https://release-assets.githubusercontent.com/official-runtime.zip";
  const fetchImpl = async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, "manual");
    if (requests.length === 1) return new Response(null, { status: 302, headers: { location: redirectURL } });
    assert.equal(url, redirectURL);
    return new Response(f.bytes);
  };
  await prepare({ ...f, arch: "arm64", fetchImpl });
  assert.equal(requests.length, 2);
  assert.equal(await readFile(join(f.outputDir, "tunnel-client"), "utf8"), payload()[0].contents);
});

test("redirects cannot contact HTTP or an unofficial host", async (t) => {
  const prepare = await fetcher();
  for (const location of ["http://github.com/runtime.zip", "https://unofficial.example/runtime.zip"]) {
    const f = await setup(t);
    let requests = 0;
    const fetchImpl = async () => {
      requests++;
      return new Response(null, { status: 302, headers: { location } });
    };
    await assert.rejects(prepare({ ...f, arch: "arm64", fetchImpl }), /outside official HTTPS|redirect/i);
    assert.equal(requests, 1);
    assert.deepEqual(await readdir(f.root), []);
  }
});
