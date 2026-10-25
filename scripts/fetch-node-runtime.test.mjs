import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NODE_RUNTIME_VERSION,
  archiveName,
  assertPinnedUrl,
  normalizeVersion,
  parseShasums,
  releaseUrl,
} from "./fetch-node-runtime.mjs";

test("the pinned runtime satisfies the project's Node.js 24+ requirement", () => {
  const major = Number(DEFAULT_NODE_RUNTIME_VERSION.split(".")[0]);
  assert.ok(major >= 24, `pinned runtime ${DEFAULT_NODE_RUNTIME_VERSION} must be Node.js 24 or newer`);
});

test("versions normalise to a bare semantic version", () => {
  assert.equal(normalizeVersion("24.22.1"), "24.22.1");
  assert.equal(normalizeVersion("v24.22.1"), "24.22.1");
  assert.equal(normalizeVersion(" 24.22.1 "), "24.22.1");
});

test("malformed or range versions are rejected", () => {
  for (const value of ["", "24", "24.22", "^24.22.1", "latest", "24.22.1-rc.1", null, undefined]) {
    assert.throws(() => normalizeVersion(value), /Invalid Node.js runtime version/, String(value));
  }
});

test("archive names follow the official release layout", () => {
  assert.equal(archiveName("24.22.1", "arm64"), "node-v24.22.1-darwin-arm64.tar.xz");
  assert.equal(archiveName("v24.22.1", "x64"), "node-v24.22.1-darwin-x64.tar.xz");
  assert.throws(() => archiveName("24.22.1", "ia32"), /Unsupported architecture/);
});

test("release URLs point at official nodejs.org HTTPS dist paths", () => {
  assert.equal(
    releaseUrl("24.22.1", "arm64"),
    "https://nodejs.org/dist/v24.22.1/node-v24.22.1-darwin-arm64.tar.xz",
  );
  assert.equal(
    releaseUrl("24.22.1", "arm64", { checksums: true }),
    "https://nodejs.org/dist/v24.22.1/SHASUMS256.txt",
  );
});

test("only official nodejs.org dist URLs are accepted", () => {
  assert.doesNotThrow(() => assertPinnedUrl("https://nodejs.org/dist/v24.22.1/SHASUMS256.txt"));
  for (const url of [
    "http://nodejs.org/dist/v24.22.1/SHASUMS256.txt",
    "https://mirror.example.com/dist/v24.22.1/SHASUMS256.txt",
    "https://nodejs.org.evil.example/dist/v24.22.1/SHASUMS256.txt",
    "https://user:pass@nodejs.org/dist/v24.22.1/SHASUMS256.txt",
    "https://nodejs.org/dist/v24.22.1/SHASUMS256.txt?x=1",
    "https://nodejs.org/other/v24.22.1/SHASUMS256.txt",
  ]) {
    assert.throws(() => assertPinnedUrl(url), /official nodejs\.org HTTPS releases/, url);
  }
});

test("SHASUMS256.txt parses into a filename to digest map", () => {
  const text = [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v24.22.1-darwin-arm64.tar.gz",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  node-v24.22.1-darwin-arm64.tar.xz",
    "",
    "not a checksum line",
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc *node-v24.22.1-darwin-x64.tar.xz",
  ].join("\n");
  const map = parseShasums(text);
  assert.equal(map.size, 3);
  assert.equal(map.get("node-v24.22.1-darwin-arm64.tar.xz"), "b".repeat(64));
  // The binary-mode asterisk prefix must not end up in the filename.
  assert.equal(map.get("node-v24.22.1-darwin-x64.tar.xz"), "c".repeat(64));
});
