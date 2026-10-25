#!/usr/bin/env node
// Acceptance gate for a packaged Chat2Local.app.
//
// A bundle only counts as valid when it can run on a Mac with no Homebrew, no
// developer Node.js, and no leftover build machine state. This checks:
//   1. required files exist and are executable
//   2. every Mach-O file resolves every dynamic dependency
//   3. no dependency points outside Apple system paths or the bundle itself
//   4. the bundled Node.js actually runs in a scrubbed environment
//   5. the bundle and each nested binary carry a valid signature
//
// Exit code 1 on any failure, so CI cannot ship a broken build.

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { architecturesOf, inspectBinary, listMachOFiles } from "./macho-deps.mjs";

const execute = promisify(execFile);

class Report {
  constructor() {
    this.failures = [];
    this.notes = [];
  }
  pass(message) { this.notes.push({ level: "pass", message }); }
  fail(message) { this.failures.push(message); this.notes.push({ level: "fail", message }); }
  info(message) { this.notes.push({ level: "info", message }); }
  print() {
    for (const note of this.notes) {
      const prefix = note.level === "pass" ? "  ok  " : note.level === "fail" ? " FAIL " : " info ";
      console.log(`${prefix} ${note.message}`);
    }
  }
}

function exists(path) {
  try { accessSync(path, constants.F_OK); return true; } catch { return false; }
}

async function tryExecute(file, args, options = {}) {
  try {
    const { stdout, stderr } = await execute(file, args, { maxBuffer: 8 * 1024 * 1024, ...options });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error.message) };
  }
}

/** Environment with no Homebrew, no DYLD overrides, no developer toolchain. */
export function scrubbedEnvironment() {
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME ?? "/tmp",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "en_US.UTF-8",
  };
  // Deliberately omit DYLD_* so a bundle that secretly needs a build machine
  // library cannot pass by inheriting the builder's environment.
  return env;
}

export async function verifyBundle(appPath, { expectedArch = process.arch === "x64" ? "x64" : "arm64" } = {}) {
  const report = new Report();
  const contents = join(appPath, "Contents");
  const resources = join(contents, "Resources");
  const macos = join(contents, "MacOS");
  const nodePath = join(resources, "node");
  const daemonPath = join(resources, "local-devd.mjs");
  const plistPath = join(contents, "Info.plist");

  // --- 1. Structure -------------------------------------------------------
  for (const [label, path] of [
    ["Info.plist", plistPath],
    ["main executable", join(macos, "LocalDevMenuBar")],
    ["bundled Node.js", nodePath],
    ["bundled daemon", daemonPath],
  ]) {
    if (exists(path)) report.pass(`${label} present`);
    else report.fail(`${label} missing at ${path}`);
  }
  if (report.failures.length > 0) return { ok: false, report };

  for (const [label, path] of [["main executable", join(macos, "LocalDevMenuBar")], ["bundled Node.js", nodePath]]) {
    try {
      const info = await stat(path);
      if (info.mode & 0o111) report.pass(`${label} is executable`);
      else report.fail(`${label} is not executable`);
    } catch (error) {
      report.fail(`${label} is unreadable: ${error.message}`);
    }
  }

  // --- 2. Bundled Node.js identity ---------------------------------------
  const nodeArch = await architecturesOf(nodePath);
  if (nodeArch.includes(expectedArch)) report.pass(`bundled Node.js architecture is ${nodeArch.join("/")}`);
  else report.fail(`bundled Node.js is ${nodeArch.join("/")}, expected ${expectedArch}`);

  const nodeVersion = await tryExecute(nodePath, ["--version"], { env: scrubbedEnvironment() });
  if (nodeVersion.ok && /^v\d+\.\d+\.\d+$/.test(nodeVersion.stdout.trim())) {
    report.pass(`bundled Node.js runs in a scrubbed environment (${nodeVersion.stdout.trim()})`);
  } else {
    report.fail(
      `bundled Node.js failed to run in a scrubbed environment: `
      + `${nodeVersion.stderr.trim().split("\n")[0] || "unknown error"}`,
    );
  }

  // --- 3. Dynamic dependency closure -------------------------------------
  const machOFiles = await listMachOFiles(appPath);
  report.info(`inspecting ${machOFiles.length} Mach-O file(s)`);
  for (const binary of machOFiles) {
    const label = relative(appPath, binary) || binary;
    let inspection;
    try {
      inspection = await inspectBinary(binary, { bundleRoot: appPath });
    } catch (error) {
      report.fail(`${label}: could not read load commands (${error.message})`);
      continue;
    }

    for (const entry of inspection.unresolved) {
      report.fail(`${label}: unresolved dependency ${entry.dependency}`);
    }
    for (const entry of inspection.external) {
      report.fail(
        `${label}: dependency escapes the bundle to a developer path: ${entry.dependency} `
        + "(this is the libnode/Homebrew failure mode)",
      );
    }
    for (const entry of inspection.nonSystem) {
      if (entry.missing || entry.external) continue;
      if (entry.kind === "absolute" && !entry.system) continue;
      if (entry.kind === "rpath" && !entry.inBundle && !entry.system) {
        report.fail(`${label}: @rpath dependency ${entry.dependency} resolves outside the bundle`);
      }
    }
    if (inspection.unresolved.length === 0 && inspection.external.length === 0) {
      const bundled = inspection.nonSystem.length;
      report.pass(`${label}: ${inspection.dependencies.length} dependencies resolve (${bundled} non-system)`);
    }
  }

  // --- 4. Licenses and provenance ----------------------------------------
  for (const [label, path] of [
    ["Node.js license", join(resources, "licenses", "node", "LICENSE.txt")],
    ["third-party notices", join(resources, "THIRD_PARTY_NOTICES.txt")],
    ["project license", join(resources, "LICENSE")],
  ]) {
    if (exists(path)) report.pass(`${label} present`);
    else report.fail(`${label} missing at ${path}`);
  }
  if (exists(join(resources, "node-runtime-provenance.json"))) {
    try {
      const provenance = JSON.parse(await readFile(join(resources, "node-runtime-provenance.json"), "utf8"));
      report.info(`Node.js runtime provenance: ${provenance.source ?? "unknown source"} (${provenance.nodeVersion ?? "?"})`);
    } catch (error) {
      report.fail(`Node.js runtime provenance is unreadable: ${error.message}`);
    }
  }

  // --- 5. Code signatures ------------------------------------------------
  const deepVerify = await tryExecute("codesign", ["--verify", "--deep", "--strict", appPath]);
  if (deepVerify.ok) report.pass("codesign --verify --deep --strict succeeded");
  else report.fail(`codesign --verify --deep --strict failed: ${deepVerify.stderr.trim().split("\n")[0]}`);

  for (const binary of machOFiles) {
    const label = relative(appPath, binary) || binary;
    const single = await tryExecute("codesign", ["--verify", "--strict", binary]);
    if (single.ok) report.pass(`${label}: signature valid`);
    else report.fail(`${label}: signature invalid (${single.stderr.trim().split("\n")[0]})`);
  }

  return { ok: report.failures.length === 0, report, machOFiles, nodeVersion: nodeVersion.stdout?.trim() };
}

function parseArgs(argv) {
  const options = { app: null, expectedArch: process.arch === "x64" ? "x64" : "arm64", quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--quiet") { options.quiet = true; continue; }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag}.`);
    index += 1;
    if (flag === "--app") options.app = value;
    else if (flag === "--arch") options.expectedArch = value;
    else throw new Error(`Unknown option "${flag}".`);
  }
  if (!options.app) throw new Error("--app is required.");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { ok, report } = await verifyBundle(options.app, { expectedArch: options.expectedArch });
  if (!options.quiet) report.print();
  if (!ok) {
    console.error(`\nBundle verification failed with ${report.failures.length} problem(s):`);
    for (const failure of report.failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("\nBundle verification passed: runtime, dependency closure, and signatures are intact.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`Bundle verification error: ${error.message}`);
    process.exit(1);
  });
}
