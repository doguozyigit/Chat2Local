import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyDependency,
  expandRpath,
  inspectBinary,
  isSelfContained,
  isSystemDependency,
  readDependencies,
  readRpaths,
  resolveDependency,
} from "./macho-deps.mjs";

test("Apple system locations are recognised", () => {
  for (const dependency of [
    "/usr/lib/libSystem.B.dylib",
    "/usr/lib/libc++.1.dylib",
    "/usr/lib/system/libdyld.dylib",
    "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation",
    "/System/Library/Frameworks/Security.framework/Versions/A/Security",
  ]) {
    assert.equal(isSystemDependency(dependency), true, dependency);
  }
});

test("developer and Homebrew paths are not system locations", () => {
  for (const dependency of [
    "/opt/homebrew/opt/libuv/lib/libuv.1.dylib",
    "/opt/homebrew/opt/node/lib/libnode.137.dylib",
    "/usr/local/opt/openssl@3/lib/libssl.3.dylib",
    "/Users/someone/build/libfoo.dylib",
    "@rpath/libnode.137.dylib",
    "relative/libfoo.dylib",
  ]) {
    assert.equal(isSystemDependency(dependency), false, dependency);
  }
});

test("dependencies are classified by install-name shape", () => {
  assert.equal(classifyDependency("/usr/lib/libz.1.dylib"), "system");
  assert.equal(classifyDependency("@rpath/libnode.137.dylib"), "rpath");
  assert.equal(classifyDependency("@loader_path/../lib/libfoo.dylib"), "loader_path");
  assert.equal(classifyDependency("@executable_path/lib/libfoo.dylib"), "executable_path");
  assert.equal(classifyDependency("/opt/homebrew/opt/libuv/lib/libuv.1.dylib"), "absolute");
});

test("rpath tokens expand relative to the referencing binary", () => {
  const binary = "/Applications/Chat2Local.app/Contents/Resources/node";
  assert.equal(expandRpath("@loader_path", binary), "/Applications/Chat2Local.app/Contents/Resources");
  assert.equal(expandRpath("@loader_path/../lib", binary), "/Applications/Chat2Local.app/Contents/lib");
  assert.equal(expandRpath("@executable_path/lib", binary), "/Applications/Chat2Local.app/Contents/Resources/lib");
  assert.equal(expandRpath("/opt/homebrew/lib", binary), "/opt/homebrew/lib");
  assert.equal(expandRpath("relative/lib", binary), null);
});

test("system dependencies resolve without touching the filesystem", () => {
  // System libraries live in the dyld shared cache on macOS 11+ and often have
  // no file on disk, so resolution must not depend on their presence.
  const resolved = resolveDependency("/usr/lib/libSystem.B.dylib", {
    binaryPath: "/tmp/does-not-exist/node",
    rpaths: [],
  });
  assert.equal(resolved, "/usr/lib/libSystem.B.dylib");
});

test("@rpath dependencies resolve through the referencing binary's rpaths", async () => {
  const root = await mkdtemp(join(tmpdir(), "macho-deps-rpath-"));
  try {
    const libDir = join(root, "node-libs");
    await mkdir(libDir, { recursive: true });
    await writeFile(join(libDir, "libnode.137.dylib"), "not a real library");
    const binary = join(root, "node");
    await writeFile(binary, "placeholder");

    const resolved = resolveDependency("@rpath/libnode.137.dylib", {
      binaryPath: binary,
      rpaths: ["@loader_path/node-libs"],
    });
    assert.equal(resolved, join(libDir, "libnode.137.dylib"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("@rpath dependencies fail to resolve when no rpath matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "macho-deps-missing-"));
  try {
    const binary = join(root, "node");
    await writeFile(binary, "placeholder");
    assert.equal(
      resolveDependency("@rpath/libnode.137.dylib", { binaryPath: binary, rpaths: ["@loader_path"] }),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a system binary reports only system dependencies", async () => {
  const dependencies = await readDependencies("/bin/ls");
  assert.ok(dependencies.length > 0, "expected /bin/ls to have dependencies");
  for (const dependency of dependencies) {
    assert.equal(isSystemDependency(dependency), true, `unexpected non-system dependency ${dependency}`);
  }
  assert.equal(await isSelfContained("/bin/ls"), true);
});

test("readRpaths returns a list of load-command rpaths", async () => {
  const rpaths = await readRpaths("/bin/ls");
  assert.ok(Array.isArray(rpaths));
  for (const rpath of rpaths) assert.equal(typeof rpath, "string");
});

test("inspectBinary flags a dependency that escapes to a developer path", async () => {
  // Regression guard for the shipped Chat2Local failure: a node launcher whose
  // install names point at /opt/homebrew must never be considered shippable.
  const root = await mkdtemp(join(tmpdir(), "macho-deps-inspect-"));
  try {
    const fakeBundle = join(root, "Chat2Local.app");
    await mkdir(join(fakeBundle, "Contents", "Resources"), { recursive: true });
    const report = await inspectBinary("/bin/ls", { bundleRoot: fakeBundle });
    assert.equal(report.external.length, 0);
    assert.equal(report.unresolved.length, 0);
    assert.equal(report.nonSystem.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
