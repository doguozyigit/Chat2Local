#!/usr/bin/env node
// Mach-O dependency analysis and runtime-closure bundling for the macOS app.
//
// The Chat2Local bundle must run on a Mac that has never had Homebrew or a
// developer Node.js installation. Everything therefore needs to be checked
// against one rule: every dynamic dependency must either be an Apple system
// library or a file that ships inside the app bundle itself.
//
// Homebrew's `node` is a ~69 KB launcher that links against
// `@rpath/libnode.<abi>.dylib` plus a dozen absolute `/opt/homebrew/...`
// libraries. Copying only that launcher produces an app that dies with
// "Library not loaded" as soon as Homebrew moves on to a new ABI version.
// This module detects that shape and can either reject it or bundle the full
// transitive closure with rewritten install names.

import { execFile } from "node:child_process";
import { copyFile, mkdir, realpath, stat } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Apple-provided locations that exist on every supported macOS install. */
const SYSTEM_PREFIXES = [
  "/usr/lib/",
  "/usr/lib/system/",
  "/System/Library/",
  "/System/iOSSupport/",
  "/Library/Apple/System/",
];

export function isSystemDependency(dependency) {
  if (typeof dependency !== "string" || !dependency.startsWith("/")) return false;
  return SYSTEM_PREFIXES.some((prefix) => dependency.startsWith(prefix));
}

export function isSystemPath(filePath) {
  return isSystemDependency(filePath) || SYSTEM_PREFIXES.some((prefix) => `${filePath}/`.startsWith(prefix));
}

function exists(filePath) {
  try {
    accessSync(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse `otool -L` output into a plain list of install names.
 * Works for thin binaries; fat headers ("Architecture ...") are skipped.
 */
export async function readDependencies(binaryPath) {
  const { stdout } = await execute("otool", ["-L", binaryPath], { maxBuffer: 8 * 1024 * 1024 });
  const dependencies = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // Skip the "<path>:" header and per-architecture fat headers.
    if (line.endsWith(":")) continue;
    const marker = line.indexOf(" (compatibility version");
    dependencies.push((marker === -1 ? line : line.slice(0, marker)).trim());
  }
  return dependencies.filter(Boolean);
}

/** Parse `otool -l` LC_RPATH entries in load-command order. */
export async function readRpaths(binaryPath) {
  const { stdout } = await execute("otool", ["-l", binaryPath], { maxBuffer: 8 * 1024 * 1024 });
  const lines = stdout.split("\n").map((line) => line.trim());
  const rpaths = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== "cmd LC_RPATH") continue;
    for (let probe = index + 1; probe < Math.min(index + 4, lines.length); probe += 1) {
      const match = /^path (.+?) \(offset \d+\)$/.exec(lines[probe]);
      if (match) {
        rpaths.push(match[1]);
        break;
      }
    }
  }
  return rpaths;
}

export function classifyDependency(dependency) {
  if (isSystemDependency(dependency)) return "system";
  if (dependency.startsWith("@rpath/")) return "rpath";
  if (dependency.startsWith("@loader_path/")) return "loader_path";
  if (dependency.startsWith("@executable_path/")) return "executable_path";
  if (isAbsolute(dependency)) return "absolute";
  return "relative";
}

export function expandRpath(rpath, binaryPath) {
  if (rpath.startsWith("@loader_path")) {
    return join(dirname(binaryPath), rpath.slice("@loader_path".length).replace(/^\//, ""));
  }
  if (rpath.startsWith("@executable_path")) {
    return join(dirname(binaryPath), rpath.slice("@executable_path".length).replace(/^\//, ""));
  }
  if (isAbsolute(rpath)) return rpath;
  return null;
}

/**
 * Resolve an install name to a concrete path, or null when it cannot resolve.
 * `bundleRoot` is only used to report whether a resolution lands inside the app.
 */
export function resolveDependency(dependency, { binaryPath, rpaths }) {
  const binaryDir = dirname(binaryPath);
  // Apple system libraries live in the dyld shared cache on macOS 11+ and are
  // frequently absent from the filesystem. Their presence on disk is not a
  // meaningful test; the loader resolves them from the cache.
  if (isSystemDependency(dependency)) return dependency;
  if (dependency.startsWith("@rpath/")) {
    const tail = dependency.slice("@rpath/".length);
    for (const rpath of rpaths) {
      const base = expandRpath(rpath, binaryPath);
      if (!base) continue;
      const candidate = resolve(base, tail);
      if (exists(candidate)) return candidate;
    }
    return null;
  }
  if (dependency.startsWith("@loader_path/")) {
    const candidate = resolve(binaryDir, dependency.slice("@loader_path/".length));
    return exists(candidate) ? candidate : null;
  }
  if (dependency.startsWith("@executable_path/")) {
    const candidate = resolve(binaryDir, dependency.slice("@executable_path/".length));
    return exists(candidate) ? candidate : null;
  }
  if (isAbsolute(dependency)) return exists(dependency) ? dependency : null;
  return null;
}

/**
 * Inspect one Mach-O file.
 *
 * `external` lists dependencies that are neither Apple system libraries nor
 * files inside the bundle — the exact failure mode that broke Chat2Local.
 * `unresolved` lists dependencies that cannot be found at all.
 */
export async function inspectBinary(binaryPath, { bundleRoot = null } = {}) {
  const dependencies = await readDependencies(binaryPath);
  const rpaths = await readRpaths(binaryPath);
  const root = bundleRoot ? resolve(bundleRoot) : null;
  const insideBundle = (candidate) => {
    if (!root || !candidate) return false;
    const resolved = resolve(candidate);
    return resolved === root || resolved.startsWith(`${root}/`);
  };

  const entries = dependencies.map((dependency) => {
    const kind = classifyDependency(dependency);
    const resolved = resolveDependency(dependency, { binaryPath, rpaths });
    return {
      dependency,
      kind,
      resolved,
      missing: resolved === null,
      external: kind === "absolute" && !isSystemDependency(dependency),
      system: kind === "system",
      inBundle: insideBundle(resolved),
    };
  });

  return {
    binaryPath,
    dependencies,
    rpaths,
    entries,
    unresolved: entries.filter((entry) => entry.missing),
    external: entries.filter((entry) => entry.external),
    nonSystem: entries.filter((entry) => !entry.system),
  };
}

/** True when the file only links against Apple system libraries. */
export async function isSelfContained(binaryPath) {
  const report = await inspectBinary(binaryPath);
  return report.nonSystem.length === 0;
}

export async function architecturesOf(binaryPath) {
  const { stdout } = await execute("lipo", ["-archs", binaryPath]);
  return stdout.trim().split(/\s+/).filter(Boolean);
}

/**
 * Copy a dynamically linked executable's transitive dylib closure into
 * `libDir` and rewrite every install name so the result resolves purely from
 * the bundle. Returns a manifest describing what was copied and rewritten.
 *
 * Used only as a fallback when an explicitly supplied Node.js build is
 * dynamic. The preferred path ships the official self-contained runtime.
 */
export async function bundleClosure({ binaryPath, libDir, relativeLibDir }) {
  await mkdir(libDir, { recursive: true });
  const rewritePlan = new Map(); // original install name -> bundled basename
  const copied = new Map(); // bundled basename -> source path
  const queue = [resolve(binaryPath)];
  const visited = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    const report = await inspectBinary(current);
    for (const entry of report.nonSystem) {
      // Resolve @rpath/@loader_path references against the *source* file so
      // transitive dependencies are discovered before rewriting.
      const sourcePath = entry.resolved
        ?? (entry.kind === "rpath" ? null : null);
      if (!sourcePath) {
        throw new Error(
          `Cannot resolve "${entry.dependency}" required by ${basename(current)}. `
          + "Install the missing library or build with a self-contained Node.js runtime.",
        );
      }
      const realSource = await realpath(sourcePath);
      const name = basename(realSource);
      const existing = copied.get(name);
      if (existing && existing !== realSource) {
        throw new Error(
          `Two different libraries share the name "${name}" (${existing} and ${realSource}); `
          + "refusing to create an ambiguous bundle.",
        );
      }
      if (!existing) {
        copied.set(name, realSource);
        queue.push(realSource);
      }
      rewritePlan.set(entry.dependency, name);
    }
  }

  for (const [name, source] of copied) {
    await copyFile(source, join(libDir, name));
  }

  // Rewrite every copied library so its own dependencies and identity point
  // into the bundle instead of /opt/homebrew or another absolute prefix.
  for (const name of copied.keys()) {
    const target = join(libDir, name);
    await execute("chmod", ["u+w", target]);
    await execute("install_name_tool", ["-id", `@loader_path/${name}`, target]);
    const report = await inspectBinary(target);
    for (const entry of report.nonSystem) {
      const replacement = rewritePlan.get(entry.dependency);
      if (!replacement) {
        throw new Error(`Unmapped dependency "${entry.dependency}" in ${name}.`);
      }
      if (entry.dependency === `@loader_path/${replacement}`) continue;
      await execute("install_name_tool", ["-change", entry.dependency, `@loader_path/${replacement}`, target]);
    }
  }

  // Point the executable at the bundled libraries via an @loader_path rpath.
  const binaryReport = await inspectBinary(binaryPath);
  await execute("chmod", ["u+w", binaryPath]);
  for (const entry of binaryReport.nonSystem) {
    const replacement = rewritePlan.get(entry.dependency);
    if (!replacement) throw new Error(`Unmapped dependency "${entry.dependency}" in the executable.`);
    await execute("install_name_tool", [
      "-change",
      entry.dependency,
      `@loader_path/${relativeLibDir}/${replacement}`,
      binaryPath,
    ]);
  }
  await execute("install_name_tool", ["-add_rpath", `@loader_path/${relativeLibDir}`, binaryPath]).catch(() => {});

  return {
    libDir,
    libraries: [...copied.entries()].map(([name, source]) => ({ name, source })),
    rewritten: [...rewritePlan.entries()].map(([from, to]) => ({ from, to })),
  };
}

/**
 * Build-time CLI.
 *   --check <binary>            print "standalone" or "dynamic"
 *   --inspect <binary>          print the dependency report as JSON
 *   --bundle-closure <binary>   copy and rewrite the transitive dylib closure
 *       --lib-dir <dir> --relative-lib-dir <name>
 */
async function main(argv) {
  const [mode, target] = argv;
  if (!mode || !target) {
    throw new Error("Usage: macho-deps.mjs --check|--inspect|--bundle-closure <binary> [options]");
  }
  if (mode === "--check") {
    const report = await inspectBinary(target);
    process.stdout.write((report.nonSystem.length === 0 ? "standalone" : "dynamic") + "\n");
    return;
  }
  if (mode === "--inspect") {
    const report = await inspectBinary(target);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (mode === "--bundle-closure") {
    const libDirIndex = argv.indexOf("--lib-dir");
    const relativeIndex = argv.indexOf("--relative-lib-dir");
    if (libDirIndex === -1 || relativeIndex === -1) {
      throw new Error("--bundle-closure requires --lib-dir and --relative-lib-dir.");
    }
    const manifest = await bundleClosure({
      binaryPath: target,
      libDir: argv[libDirIndex + 1],
      relativeLibDir: argv[relativeIndex + 1],
    });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown mode "${mode}".`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`macho-deps: ${error.message}`);
    process.exit(1);
  });
}

/** Recursively list Mach-O files in a directory. */
export async function listMachOFiles(rootDir) {
  const { readdir } = await import("node:fs/promises");
  const found = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(full);
        if (!(info.mode & 0o111)) continue;
        const { stdout } = await execute("file", ["-b", full]);
        if (/Mach-O/.test(stdout)) found.push(full);
      } catch {
        // Unreadable entries are reported by the caller's own checks.
      }
    }
  }
  await walk(rootDir);
  return found.sort();
}
