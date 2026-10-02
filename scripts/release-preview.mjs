#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// Changes to this allowlist must be reviewed when adding a new source location.
const SOURCE_FILES = new Set([
  ".gitignore", "README.md", "CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md", "TROUBLESHOOTING.md",
  "LICENSE", "LICENSE.md", "LICENSE.txt", "package.json", "package-lock.json",
  "tsconfig.base.json", "apps/daemon/package.json", "apps/daemon/tsconfig.json",
  "apps/macos/Package.swift", "packages/protocol/package.json", "packages/protocol/tsconfig.json",
  "packages/installer/LICENSE",
]);
const SOURCE_TREES = [
  ".github/workflows", "docs", "examples", "scripts", "apps/daemon/src",
  "apps/macos/Sources", "apps/macos/Tests", "packages/protocol/src", "packages/installer", "plugin/local-dev",
];
const SOURCE_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yml", ".yaml", ".ts", ".mjs", ".js", ".sh",
  ".swift", ".plist", ".py", ".html", ".css", ".svg",
]);
const IGNORED_DIRECTORIES = new Set([
  "node_modules", "dist", "build", ".build", ".swiftpm", ".git", ".cache",
  ".local-dev", ".local-signing", ".chatgpt-browser-profile", "profiles",
]);
const PRIVATE_OR_RUNTIME_FILE = /^(?:\.env(?:\..*)?|api-token|vault\.key|secrets(?:\..*)?|credentials(?:\..*)?|keychain-password|.*\.log|.*\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?|.*\.(?:key|pem|p12|pfx|keychain|keychain-db|crt|cer|der))$/i;
const GENERIC_HOME_NAMES = new Set(["you", "user", "username", "example", "example-user", "root", "shared", "runner", "test"]);
const SECRET_RULES = [
  ["private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ["openai-api-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["google-api-key", /\bAIza[A-Za-z0-9_-]{30,}\b/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+\/-]{24,}={0,2}/gi],
  ["credential-literal", /\b(?:api[_-]?key|runtimeApiKey|api[_-]?token|access[_-]?token|secret|password)\b["']?\s*[:=]\s*["'][A-Za-z0-9_./+\-=]{24,}["']/gi],
];
const LIMITATION = "This checks the selected source for specific sensitive-content patterns. It does not prove that every secret or security issue has been found. It never scans credential stores or excluded runtime directories.";

function wanted(path) {
  return SOURCE_FILES.has(path) || [...SOURCE_FILES].some((file) => file.startsWith(`${path}/`))
    || SOURCE_TREES.some((tree) => path === tree || tree.startsWith(`${path}/`) || path.startsWith(`${tree}/`));
}

function finding(path, rule, line = 1, column = 1) {
  return { path, line, column, rule };
}

function scanText(path, text) {
  const findings = [];
  const at = (index, rule) => {
    const before = text.slice(0, index);
    const line = before.split("\n").length;
    const column = index - before.lastIndexOf("\n");
    findings.push(finding(path, rule, line, column));
  };
  for (const [rule, pattern] of SECRET_RULES) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) at(match.index, rule);
  }
  for (const match of text.matchAll(/(?:\/Users\/|\/home\/)([A-Za-z0-9._-]+)(?=\/)/g)) {
    if (!GENERIC_HOME_NAMES.has(match[1].toLowerCase())) at(match.index, "personal-home-path");
  }
  return findings;
}

async function inspectSource(root, { requireLicense }) {
  const files = [];
  const findings = [];
  const warnings = [];
  async function visit(relative = "") {
    const names = (await readdir(join(root, relative))).sort();
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name;
      if (name === ".DS_Store" || IGNORED_DIRECTORIES.has(name) || /^\.tmp(?:$|-)/.test(name) || !wanted(path)) continue;
      const absolute = join(root, path);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        findings.push(finding(path, "source-symlink"));
        continue;
      }
      if (stat.isDirectory()) {
        await visit(path);
        continue;
      }
      if (PRIVATE_OR_RUNTIME_FILE.test(name)) {
        findings.push(finding(path, "private-or-runtime-file"));
        continue;
      }
      if (!stat.isFile()) {
        findings.push(finding(path, "non-regular-source-file"));
        continue;
      }
      if (!SOURCE_FILES.has(path) && !SOURCE_EXTENSIONS.has(extname(name))) {
        findings.push(finding(path, "unsupported-source-file"));
        continue;
      }
      let handle;
      try {
        // O_NOFOLLOW prevents a last-component symlink replacement during this read.
        handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        const current = await handle.stat();
        if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino) throw new Error("source changed");
        const contents = await handle.readFile();
        if (contents.includes(0)) {
          findings.push(finding(path, "binary-source-file"));
          continue;
        }
        findings.push(...scanText(path, contents.toString("utf8")));
        files.push({ path, contents, size: contents.length, mode: stat.mode & 0o111 ? "0755" : "0644", sha256: createHash("sha256").update(contents).digest("hex") });
      } catch {
        // File contents and underlying error messages never enter reports.
        findings.push(finding(path, "source-read-failed"));
      } finally {
        await handle?.close();
      }
    }
  }
  await visit();
  // ASCII order is consistent across machines and matches archive ordering.
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const required of ["README.md", "package.json", "package-lock.json"]) {
    if (!files.some((file) => file.path === required)) findings.push(finding(required, "required-source-missing"));
  }
  const license = files.find((file) => ["LICENSE", "LICENSE.md", "LICENSE.txt"].includes(file.path) && file.contents.toString("utf8").trim());
  if (!license) (requireLicense ? findings : warnings).push(finding("LICENSE", "license-missing"));
  let version;
  try {
    version = JSON.parse(files.find((file) => file.path === "package.json")?.contents.toString("utf8") ?? "{}").version;
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(version)) {
      findings.push(finding("package.json", "invalid-package-version"));
    }
  } catch {
    findings.push(finding("package.json", "invalid-package-json"));
  }
  findings.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
  return { files, findings, warnings, version, license: license?.path ?? null };
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function tarEntry(path, contents, mode) {
  const header = Buffer.alloc(512);
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(path) > 100) {
    const split = path.lastIndexOf("/");
    name = path.slice(split + 1);
    prefix = path.slice(0, split);
  }
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error("archive-path-too-long");
  header.write(name, 0, 100);
  const octal = (value, offset, width) => header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width);
  octal(Number.parseInt(mode, 8), 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(contents.length, 124, 12);
  octal(0, 136, 12);
  header.fill(32, 148, 156);
  header.write("0", 156, 1);
  header.write("ustar\0", 257, 6);
  header.write("00", 263, 2);
  header.write(prefix, 345, 155);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return [header, contents, Buffer.alloc((512 - contents.length % 512) % 512)];
}

async function exportSource(inspection, outputDir) {
  const archiveRoot = `chat2local-preview-${inspection.version}`;
  const manifest = {
    formatVersion: 1,
    project: "chat2local",
    version: inspection.version,
    archiveRoot,
    files: inspection.files.map(({ path, size, mode, sha256 }) => ({ path, size, mode, sha256 })),
  };
  const scan = {
    formatVersion: 1,
    scope: "allowlisted source files in RELEASE_MANIFEST.json",
    fileCount: inspection.files.length,
    rules: [...SECRET_RULES.map(([name]) => name), "personal-home-path", "source-symlink", "private-or-runtime-file", "non-regular-source-file", "unsupported-source-file", "binary-source-file", "source-read-failed", "required-source-missing", "license-missing", "invalid-package-version", "invalid-package-json"],
    findings: inspection.findings,
    warnings: inspection.warnings,
    limitation: LIMITATION,
  };
  const manifestBytes = jsonBytes(manifest);
  const scanBytes = jsonBytes(scan);
  const entries = [
    ...inspection.files,
    { path: "RELEASE_MANIFEST.json", contents: manifestBytes, mode: "0644" },
    { path: "RELEASE_SCAN.json", contents: scanBytes, mode: "0644" },
  ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const parts = entries.flatMap((file) => tarEntry(`${archiveRoot}/${file.path}`, file.contents, file.mode));
  parts.push(Buffer.alloc(1024));
  const archiveBytes = gzipSync(Buffer.concat(parts), { level: 9 });
  await mkdir(outputDir, { recursive: true });
  const output = await lstat(outputDir);
  if (!output.isDirectory() || output.isSymbolicLink()) throw new Error("output-directory-must-be-regular");
  const archivePath = join(outputDir, `${archiveRoot}.tar.gz`);
  const manifestPath = join(outputDir, `${archiveRoot}.manifest.json`);
  const scanReportPath = join(outputDir, `${archiveRoot}.scan.json`);
  for (const [path, contents] of [[archivePath, archiveBytes], [manifestPath, manifestBytes], [scanReportPath, scanBytes]]) {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
    try { await handle.writeFile(contents); } finally { await handle.close(); }
  }
  return { archiveRoot, archivePath, archiveSha256: createHash("sha256").update(archiveBytes).digest("hex"), manifestPath, scanReportPath };
}

async function main() {
  let root = fileURLToPath(new URL("../", import.meta.url));
  let outputDir;
  let mode = "--check";
  let explicitMode = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--check" || arg === "--export") {
      if (explicitMode) throw new Error("choose-one-mode");
      mode = arg;
      explicitMode = true;
    } else if (arg === "--root" || arg === "--output-dir") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("missing-option-value");
      if (arg === "--root") root = resolve(value);
      else outputDir = resolve(value);
    } else if (arg === "--help") {
      process.stdout.write("Usage: node scripts/release-preview.mjs [--check | --export] [--root DIRECTORY] [--output-dir DIRECTORY]\nCheck is read-only. Export requires a license and no scan findings, and creates a deterministic source tar.gz with its manifest and scan report.\n");
      return;
    } else throw new Error("unknown-option");
  }
  root = await realpath(root);
  const inspection = await inspectSource(root, { requireLicense: mode === "--export" });
  const report = {
    mode: mode.slice(2),
    status: inspection.findings.length ? "blocked" : "passed",
    fileCount: inspection.files.length,
    files: inspection.files.map((file) => file.path),
    license: inspection.license,
    findings: inspection.findings,
    warnings: inspection.warnings,
    limitation: LIMITATION,
  };
  if (mode === "--export" && !inspection.findings.length) {
    Object.assign(report, await exportSource(inspection, outputDir ?? join(root, "dist")));
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = inspection.findings.length ? 1 : 0;
}

main().catch(() => {
  // Keep arbitrary errors, which may contain source excerpts, out of public logs.
  process.stdout.write(`${JSON.stringify({ status: "blocked", findings: [{ path: "release", line: 1, column: 1, rule: "release-operation-failed" }], limitation: LIMITATION }, null, 2)}\n`);
  process.exitCode = 1;
});
