import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, contents] of entries) {
    const path = Buffer.from(name), bytes = Buffer.from(contents);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30), record = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(path.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4);
    record.writeUInt16LE(20, 6); record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(path.length, 28); record.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    local.push(header, path, bytes); central.push(record, path);
    offset += header.length + path.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "local-dev-license-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reportPath = join(root, "report.txt"), outputDir = join(root, "licenses");
  const text = "DEPENDENCY|TYPE|VERSION|LICENSES|LICENSE_FILE|PLATFORMS\nexample.org/SomeModule/pkg|direct|v1.2.3|MIT|example.org/SomeModule@v1.2.3/LICENSE|darwin/arm64\nexample.org/SomeModule/other|transitive|v1.2.3|MIT|example.org/SomeModule@v1.2.3/LICENSE|darwin/arm64\n";
  await writeFile(reportPath, text);
  const archive = zip([
    ["example.org/SomeModule@v1.2.3/LICENSE", "Copyright 2026 Example author\nPermission is granted...\n"],
    ["example.org/SomeModule@v1.2.3/NOTICE", "Example attribution notice\n"],
    ["example.org/SomeModule@v1.2.3/source.go", "package example\n"],
  ]);
  const requests = [];
  const fetchImpl = async (url) => { requests.push(url); return new Response(archive); };
  return { root, reportPath, outputDir, archive, requests, fetchImpl };
}

async function collector() {
  try { return (await import("./collect-tunnel-licenses.mjs")).collectTunnelLicenses; }
  catch (error) { assert.fail(`Dependency license collector must exist: ${error.code ?? error.message}`); }
}

test("collection preserves full copyright texts and root notices from exact module ZIP", async (t) => {
  const f = await fixture(t), collect = await collector();
  const index = await collect(f);
  assert.deepEqual(f.requests, ["https://proxy.golang.org/example.org/!some!module/@v/v1.2.3.zip"]);
  assert.equal(index.count, 2);
  assert.equal(index.modules.length, 1);
  assert.equal(index.modules[0].archiveSha256, createHash("sha256").update(f.archive).digest("hex"));
  assert.ok(index.licenses.some((entry) => entry.optionalNotice));
  assert.ok((await readFile(join(f.outputDir, index.licenses[0].file), "utf8")).includes("Copyright 2026 Example author"));
  assert.equal((await readdir(f.outputDir)).length, 3);
});

test("unchanged cached licenses are reused only after every recorded hash matches", async (t) => {
  const f = await fixture(t), collect = await collector();
  const first = await collect(f);
  const second = await collect({ ...f, fetchImpl: () => assert.fail("Valid cache must avoid network") });
  assert.deepEqual(second, first);
  await writeFile(join(f.outputDir, first.licenses[0].file), "tampered");
  const repaired = await collect(f);
  assert.equal(f.requests.length, 2);
  assert.ok((await readFile(join(f.outputDir, repaired.licenses[0].file), "utf8")).includes("Copyright"));
});

test("invalid module, version and license paths fail before downloading", async (t) => {
  const f = await fixture(t), collect = await collector();
  for (const licenseFile of ["../elsewhere@v1.2.3/LICENSE", "example.org/mod@v1.2.3/../../escape", "example.org/mod@bad/LICENSE", "example.org/mod@v1.2.3/LICENSE?*"]) {
    await writeFile(f.reportPath, `DEPENDENCY|TYPE|VERSION|LICENSES|LICENSE_FILE|PLATFORMS\nexample.org/mod|direct|v1.2.3|MIT|${licenseFile}|darwin/arm64\n`);
    await assert.rejects(collect(f), /license|module|version|path/i);
  }
  assert.equal(f.requests.length, 0);
});

test("missing licenses and duplicate ZIP members do not produce an accepted cache", async (t) => {
  const f = await fixture(t), collect = await collector();
  for (const archive of [zip([["example.org/SomeModule@v1.2.3/source.go", "package example"]]), zip([["example.org/SomeModule@v1.2.3/LICENSE", "one"], ["example.org/SomeModule@v1.2.3/LICENSE", "two"]])]) {
    await assert.rejects(collect({ ...f, fetchImpl: async () => new Response(archive) }), /license|duplicate|archive/i);
    assert.ok(!(await readdir(f.root)).includes("licenses"));
  }
});

test("oversized module downloads and insecure redirects are rejected", async (t) => {
  const f = await fixture(t), collect = await collector();
  await assert.rejects(collect({ ...f, fetchImpl: async () => new Response("large", { headers: { "content-length": "33554433" } }) }), /large|size/i);
  let calls = 0;
  await assert.rejects(collect({ ...f, fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://untrusted.example/module.zip" } }); } }), /HTTPS|redirect/i);
  assert.equal(calls, 1);
});
