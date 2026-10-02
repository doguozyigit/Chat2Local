import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
export type { ChatFolderScope as ConversationScope } from "./chat-folder-store.js";

const execFileAsync = promisify(execFile);

export async function readScopedFile(
  root: string,
  requestedPath: string,
  startLine?: number,
  endLine?: number,
): Promise<{
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
}> {
  const path = await resolveReadablePath(root, requestedPath);
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Path is not a file");
  if (info.size > 2 * 1024 * 1024) {
    throw new Error("File is larger than the 2 MB text-read limit");
  }

  const content = await readFile(path, "utf8");
  const lines = content.split(/\r?\n/);
  const first = clamp(startLine ?? 1, 1, Math.max(lines.length, 1));
  const last = clamp(endLine ?? lines.length, first, lines.length);

  return {
    path,
    content: lines.slice(first - 1, last).join("\n"),
    startLine: first,
    endLine: last,
    totalLines: lines.length,
  };
}

export async function writeScopedFile(
  root: string,
  requestedPath: string,
  content: string,
): Promise<{ path: string; bytes: number }> {
  return defaultScopedFileWriter.writeScopedFile(root, requestedPath, content);
}

export async function editScopedFile(
  root: string,
  requestedPath: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): Promise<{ path: string; replacements: number }> {
  return defaultScopedFileWriter.editScopedFile(root, requestedPath, oldText, newText, replaceAll);
}

export type ScopedWritePhase = "stageCreated" | "stageWritten" | "staged" | "beforeCommit" | "committed";

export interface ScopedFileWriterOptions {
  // Production may record stage evidence; tests can stop at a deterministic phase.
  onPhase?: (info: { phase: ScopedWritePhase; path: string; stagingPath: string; stagingDevice: string; stagingInode: string }) => void | Promise<void>;
}

// All writer instances, including tools used by different chats, share a lock
// for the canonical destination. An edit reads its original while holding it.
const scopedWriteLocks = new Map<string, Promise<void>>();

export function createScopedFileWriter(options: ScopedFileWriterOptions = {}) {
  const onPhase = options.onPhase;
  return {
    async writeScopedFile(root: string, requestedPath: string, content: string): Promise<{ path: string; bytes: number }> {
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > 2 * 1024 * 1024) throw new Error("File content is larger than the 2 MB write limit");
      return withScopedWrite(root, requestedPath, true, async (scope, path, directories, original) => {
        await writeContainedFile(scope, path, directories, original, Buffer.from(content, "utf8"), onPhase);
        return { path, bytes };
      });
    },
    async editScopedFile(root: string, requestedPath: string, oldText: string, newText: string, replaceAll: boolean): Promise<{ path: string; replacements: number }> {
      if (!oldText) throw new Error("oldText must not be empty");
      return withScopedWrite(root, requestedPath, false, async (scope, path, directories, original) => {
        const content = original!.content.toString("utf8");
        const occurrences = countOccurrences(content, oldText);
        if (occurrences === 0) throw new Error("oldText was not found in the file");
        if (!replaceAll && occurrences !== 1) {
          throw new Error(`oldText matched ${occurrences} times; make the edit more specific or set replaceAll=true`);
        }
        const updated = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
        await writeContainedFile(scope, path, directories, original, Buffer.from(updated, "utf8"), onPhase);
        return { path, replacements: replaceAll ? occurrences : 1 };
      });
    },
  };
}

const defaultScopedFileWriter = createScopedFileWriter();

export async function listScopedDirectory(
  root: string,
  requestedPath?: string,
): Promise<{
  path: string;
  entries: Array<{ name: string; type: "file" | "directory" | "other" }>;
  truncated: boolean;
}> {
  const path = await resolveReadablePath(root, requestedPath ?? ".");
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error("Path is not a directory");

  const items = await readdir(path, { withFileTypes: true });
  const entries = items
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 250)
    .map((item) => ({
      name: item.name,
      type: item.isDirectory()
        ? "directory" as const
        : item.isFile()
          ? "file" as const
          : "other" as const,
    }));

  return {
    path,
    entries,
    truncated: items.length > entries.length,
  };
}

export async function searchScopedText(
  root: string,
  query: string,
  requestedPath?: string,
): Promise<{
  path: string;
  matches: string[];
  truncated: boolean;
}> {
  if (!query.trim()) throw new Error("query must not be empty");

  const path = await resolveReadablePath(root, requestedPath ?? ".");
  const args = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--hidden",
    "--glob",
    "!.git/**",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!dist/**",
    "--glob",
    "!.build/**",
    "--max-filesize",
    "2M",
    "--",
    query,
    path,
  ];

  try {
    const { stdout } = await execFileAsync("rg", args, {
      cwd: root,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 15_000,
    });
    const all = stdout.split(/\r?\n/).filter(Boolean);
    return {
      path,
      matches: all.slice(0, 250),
      truncated: all.length > 250,
    };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 1 || code === "1") {
      return { path, matches: [], truncated: false };
    }
    if (code === "ENOENT") {
      return searchScopedTextWithoutRipgrep(path, query);
    }
    throw error;
  }
}

const searchIgnoredDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  ".build",
]);

async function searchScopedTextWithoutRipgrep(
  path: string,
  query: string,
): Promise<{
  path: string;
  matches: string[];
  truncated: boolean;
}> {
  let pattern: RegExp;
  try {
    pattern = new RegExp(query);
  } catch (error) {
    throw new Error(
      `Invalid search pattern: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const matches: string[] = [];
  let truncated = false;

  const searchFile = async (filePath: string): Promise<boolean> => {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) {
      return false;
    }

    const content = await readFile(filePath, "utf8");
    if (content.includes("\0")) {
      return false;
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!pattern.test(lines[index]!)) {
        continue;
      }
      if (matches.length >= 250) {
        truncated = true;
        return true;
      }
      matches.push(`${filePath}:${index + 1}:${lines[index]}`);
    }
    return false;
  };

  const visit = async (candidate: string): Promise<boolean> => {
    const info = await stat(candidate);
    if (info.isFile()) {
      return searchFile(candidate);
    }
    if (!info.isDirectory()) {
      return false;
    }

    const entries = await readdir(candidate, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (
        entry.isDirectory()
        && searchIgnoredDirectories.has(entry.name)
      ) {
        continue;
      }
      if (!entry.isDirectory() && !entry.isFile()) {
        continue;
      }

      const shouldStop = await visit(join(candidate, entry.name));
      if (shouldStop) {
        return true;
      }
    }

    return false;
  };

  await visit(path);
  return { path, matches, truncated };
}

export async function runScopedShell(
  root: string,
  command: string,
  requestedCwd?: string,
  timeoutMs = 60_000,
): Promise<{
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}> {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("command must not be empty");
  rejectObviouslyDangerousCommand(trimmed);

  const cwd = await resolveScopedPath(root, requestedCwd ?? ".", false);
  const cwdInfo = await stat(cwd);
  if (!cwdInfo.isDirectory()) throw new Error("cwd is not a directory");

  const limit = clamp(timeoutMs, 1_000, 120_000);
  const maxBuffer = 4 * 1024 * 1024;
  const rootReal = await realpath(resolve(root)).catch(() => resolve(root));
  // sandbox-exec evaluates the canonical /private/var/folders path even when
  // macOS reports /var/folders. xcrun also writes its cache directly in this
  // per-user temp root, so keep that narrow temp location writable.
  const rawSystemTempRoot = tmpdir();
  const systemTempRoot = await realpath(rawSystemTempRoot).catch(
    () => rawSystemTempRoot,
  );
  const tempRoot = await mkdtemp(join(systemTempRoot, "local-dev-shell-"));

  try {
    const useMacSandbox =
      process.platform === "darwin"
      && await exists("/usr/bin/sandbox-exec");

    const executable = useMacSandbox ? "/usr/bin/sandbox-exec" : "/bin/zsh";
    const args = useMacSandbox
      ? [
          "-p",
          shellSandboxPolicy(rootReal, tempRoot, systemTempRoot),
          "/bin/zsh",
          "-lc",
          trimmed,
        ]
      : ["-lc", trimmed];

    const { stdout, stderr } = await execFileAsync(executable, args, {
      cwd,
      timeout: limit,
      maxBuffer,
      env: {
        ...process.env,
        HOME: tempRoot,
        TMPDIR: tempRoot + sep,
        XDG_CACHE_HOME: join(tempRoot, "cache"),
        GIT_CONFIG_GLOBAL: "/dev/null",
        LOCAL_DEV_PROJECT_ROOT: rootReal,
      },
    });

    return {
      cwd,
      exitCode: 0,
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr),
      truncated:
        stdout.length > 120_000
        || stderr.length > 120_000,
    };
  } catch (error) {
    const result = error as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };

    const exitCode =
      typeof result.code === "number"
        ? result.code
        : result.killed
          ? 124
          : 1;

    return {
      cwd,
      exitCode,
      stdout: truncateOutput(result.stdout ?? ""),
      stderr: truncateOutput(
        result.stderr
        ?? (result.killed
          ? `Command timed out after ${limit} ms`
          : result.message),
      ),
      truncated:
        (result.stdout?.length ?? 0) > 120_000
        || (result.stderr?.length ?? 0) > 120_000,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function resolveReadablePath(
  projectRoot: string,
  requestedPath: string,
): Promise<string> {
  if (!isAbsolute(requestedPath)) {
    return resolveScopedPath(projectRoot, requestedPath, false);
  }

  const requestedAbsolute = resolve(requestedPath);
  const candidateRoots = [projectRoot];
  const rootReals: string[] = [];

  for (const rootInput of candidateRoots) {
    const rootAbsolute = resolve(rootInput);
    const rootReal = await realpath(rootAbsolute).catch(() => rootAbsolute);
    rootReals.push(rootReal);
    if (
      !isWithin(rootAbsolute, requestedAbsolute)
      && !isWithin(rootReal, requestedAbsolute)
    ) {
      continue;
    }

    const requestedReal = await realpath(requestedAbsolute);
    if (isWithin(rootReal, requestedReal)) {
      return requestedReal;
    }
  }

  // A symlinked alias of a root (macOS: /var -> /private/var) only matches by
  // canonical path. A path that cannot be resolved gets the same refusal as one
  // outside the scope, so the error never reveals whether it exists.
  const aliasReal = await realpath(requestedAbsolute).catch(() => undefined);
  if (aliasReal !== undefined && rootReals.some((rootReal) => isWithin(rootReal, aliasReal))) {
    return aliasReal;
  }

  throw new Error("Path escapes the Chat2Local readable scope");
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const offset = relative(normalizedRoot, normalizedCandidate);
  return offset === ""
    || (offset !== ".."
      && !offset.startsWith(".." + sep)
      && !isAbsolute(offset));
}

async function resolveScopedPath(
  rootInput: string,
  requestedPath: string,
  allowMissing: boolean,
): Promise<string> {
  const rootAbsolute = resolve(rootInput);
  const rootReal = await realpath(rootAbsolute).catch(() => rootAbsolute);
  const requestedAbsolute = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(rootAbsolute, requestedPath);

  assertWithin(rootAbsolute, requestedAbsolute);

  if (!allowMissing) {
    const requestedReal = await realpath(requestedAbsolute);
    assertWithin(rootReal, requestedReal);
    return requestedReal;
  }

  // lstat, not access: a dangling symlink is an existing entry, not a missing
  // path, otherwise the walk skips it and a later write follows it out of scope.
  let ancestor = requestedAbsolute;
  while (!(await entryExists(ancestor))) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  const ancestorReal = await realpath(ancestor).catch(() => {
    throw new Error("Path resolves through a broken symbolic link");
  });
  assertWithin(rootReal, ancestorReal);

  const suffix = relative(ancestor, requestedAbsolute);
  const finalPath = resolve(ancestorReal, suffix);
  assertWithin(rootReal, finalPath);
  return finalPath;
}

function assertWithin(root: string, candidate: string): void {
  if (!isWithin(root, candidate)) {
    throw new Error("Path escapes the Chat2Local project scope");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

interface WriteScope { absolute: string; real: string; identity: BigIntStats }
interface PinnedDirectory { path: string; identity: BigIntStats }
interface FileSnapshot { identity: BigIntStats; content: Buffer }

async function withScopedWrite<T>(
  root: string,
  requestedPath: string,
  create: boolean,
  action: (scope: WriteScope, path: string, directories: PinnedDirectory[], original: FileSnapshot | null) => Promise<T>,
): Promise<T> {
  const absolute = resolve(root);
  const real = realpathSync(absolute);
  const scope: WriteScope = { absolute, real, identity: lstatSync(real, { bigint: true }) };
  const path = await resolveScopedPath(root, requestedPath, create);
  assertWriteScope(scope);
  return withCanonicalWriteLock(path, async () => {
    assertWriteScope(scope);
    const currentPath = await resolveScopedPath(root, requestedPath, create);
    if (currentPath !== path) throw new Error("Path changed while it was being written");
    assertWriteScope(scope);
    const directories = pinWriteDirectories(scope, dirname(path), create);
    const original = snapshotContainedFile(scope, path, directories, create);
    return action(scope, path, directories, original);
  });
}

async function withCanonicalWriteLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = scopedWriteLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  scopedWriteLocks.set(path, tail);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (scopedWriteLocks.get(path) === tail) scopedWriteLocks.delete(path);
  }
}

function assertWriteScope(scope: WriteScope): void {
  if (
    realpathSync(scope.absolute) !== scope.real
    || !sameIdentity(scope.identity, lstatSync(scope.real, { bigint: true }))
  ) throw new Error("Selected folder changed while the file was being written");
}

function pinWriteDirectories(scope: WriteScope, parent: string, create: boolean): PinnedDirectory[] {
  assertWithin(scope.real, parent);
  const directories: PinnedDirectory[] = [{ path: scope.real, identity: scope.identity }];
  let current = scope.real;
  for (const part of relative(scope.real, parent).split(sep).filter(Boolean)) {
    assertWriteDirectories(scope, directories);
    current = join(current, part);
    let info: BigIntStats;
    try { info = lstatSync(current, { bigint: true }); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current);
      info = lstatSync(current, { bigint: true });
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Parent folder changed while the file was being written");
    directories.push({ path: current, identity: info });
  }
  assertWriteDirectories(scope, directories);
  return directories;
}

function assertWriteDirectories(scope: WriteScope, directories: PinnedDirectory[]): void {
  assertWriteScope(scope);
  for (const directory of directories) {
    const current = lstatSync(directory.path, { bigint: true });
    if (!current.isDirectory() || !sameIdentity(directory.identity, current)) {
      throw new Error("Parent folder changed while the file was being written");
    }
    assertWithin(scope.real, realpathSync(directory.path));
  }
}

function snapshotContainedFile(scope: WriteScope, path: string, directories: PinnedDirectory[], allowMissing: boolean): FileSnapshot | null {
  assertWriteDirectories(scope, directories);
  let current: BigIntStats;
  try { current = lstatSync(path, { bigint: true }); }
  catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (current.isSymbolicLink()) throw new Error("Path changed to a symbolic link while it was being written");
  if (!current.isFile()) throw new Error("Path is not a file");
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    assertWriteDirectories(scope, directories);
    assertWithin(scope.real, realpathSync(path));
    if (!opened.isFile() || !sameVersion(current, opened) || !sameIdentity(opened, lstatSync(path, { bigint: true }))) {
      throw new Error("Path changed while it was being written");
    }
    const content = readFileSync(fd);
    if (!sameVersion(opened, fstatSync(fd, { bigint: true }))) throw new Error("File changed while it was being read for a write");
    return { identity: opened, content };
  } finally { closeSync(fd); }
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameVersion(a: BigIntStats, b: BigIntStats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mode === b.mode && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

// A private file in the destination directory receives all bytes and is fsynced
// before replacing the destination. The final checks and rename are synchronous
// so another daemon operation cannot run between them. Portable Node does not
// expose renameat: a hostile same-user process can still race filesystem calls.
async function writeContainedFile(
  scope: WriteScope,
  path: string,
  directories: PinnedDirectory[],
  original: FileSnapshot | null,
  content: Buffer,
  onPhase: ScopedFileWriterOptions["onPhase"],
): Promise<void> {
  const stagingPath = join(dirname(path), `.local-dev-stage-${process.pid}-${randomUUID()}.tmp`);
  let stageFd: number | undefined;
  let parentFd: number | undefined;
  let stageIdentity: BigIntStats | undefined;
  let committed = false;
  const phase = async (value: ScopedWritePhase) => { await onPhase?.({ phase: value, path, stagingPath, stagingDevice: String(stageIdentity!.dev), stagingInode: String(stageIdentity!.ino) }); };
  const assertStage = () => {
    assertWriteDirectories(scope, directories);
    const current = lstatSync(stagingPath, { bigint: true });
    if (!current.isFile() || !sameIdentity(stageIdentity!, current)) throw new Error("Staging file changed while the file was being written");
  };
  try {
    assertWriteDirectories(scope, directories);
    parentFd = openSync(dirname(path), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    if (!sameIdentity(directories.at(-1)!.identity, fstatSync(parentFd, { bigint: true }))) {
      throw new Error("Parent folder changed while the file was being written");
    }
    assertWriteDirectories(scope, directories);
    stageFd = openSync(stagingPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    stageIdentity = fstatSync(stageFd, { bigint: true });
    assertStage();
    await phase("stageCreated");
    assertStage();
    writeFileSync(stageFd, content);
    await phase("stageWritten");
    assertStage();
    fchmodSync(stageFd, Number(original?.identity.mode ?? BigInt(0o666 & ~process.umask())) & 0o7777);
    fsyncSync(stageFd);
    const syncedStage = fstatSync(stageFd, { bigint: true });
    await phase("staged");
    await phase("beforeCommit");
    assertStage();
    const staged = snapshotContainedFile(scope, stagingPath, directories, false)!;
    if (!sameVersion(syncedStage, staged.identity) || !staged.content.equals(content)) {
      throw new Error("Staging file changed before the save could be committed");
    }
    const current = snapshotContainedFile(scope, path, directories, true);
    if (
      (original === null) !== (current === null)
      || (original !== null && current !== null && (!sameVersion(original.identity, current.identity) || !original.content.equals(current.content)))
    ) throw new Error("File changed before the staged save could be committed");
    assertStage();
    renameSync(stagingPath, path);
    committed = true;
    const saved = snapshotContainedFile(scope, path, directories, false)!;
    if (!sameIdentity(stageIdentity, saved.identity) || !saved.content.equals(content)) {
      throw new Error("Path changed immediately after the file save was committed");
    }
    assertWriteDirectories(scope, directories);
    try { fsyncSync(parentFd); }
    catch (error) {
      if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    await phase("committed");
  } finally {
    if (!committed && stageIdentity !== undefined) {
      // Only this operation's exact inode may be removed. If its folder was
      // swapped, leave it for inspection rather than traversing the new path.
      try { assertStage(); unlinkSync(stagingPath); } catch { /* preserve uncertain stages */ }
    }
    if (stageFd !== undefined) closeSync(stageFd);
    if (parentFd !== undefined) closeSync(parentFd);
  }
}

function shellSandboxPolicy(
  projectRoot: string,
  tempRoot: string,
  systemTempRoot: string,
): string {
  const readableSystemRoots = [
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/Library",
    "/Applications",
    "/opt",
    "/private/etc",
    "/private/var/db",
    "/dev",
  ];

  const traversalRules = [
    ...pathAncestors(projectRoot),
    ...pathAncestors(tempRoot),
    ...pathAncestors(systemTempRoot),
  ]
    .filter((path, index, values) => values.indexOf(path) === index)
    .map((path) => `    (literal ${sandboxLiteral(path)})`);

  const readRules = [
    ...traversalRules,
    ...[projectRoot, tempRoot, systemTempRoot, ...readableSystemRoots]
      .map((path) => `    (subpath ${sandboxLiteral(path)})`),
  ].join("\n");

  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow signal)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow network*)",
    "(allow ipc-posix*)",
    "(allow file-read-metadata)",
    "(allow file-read*",
    readRules,
    ")",
    "(allow file-write*",
    `    (subpath ${sandboxLiteral(projectRoot)})`,
    `    (subpath ${sandboxLiteral(tempRoot)})`,
    `    (subpath ${sandboxLiteral(systemTempRoot)})`,
    '    (literal "/dev/null")',
    ")",
  ].join("\n");
}

function pathAncestors(value: string): string[] {
  const absolute = resolve(value);
  const ancestors: string[] = [];
  let current = dirname(absolute);

  while (true) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return ancestors;
}

function sandboxLiteral(value: string): string {
  return JSON.stringify(resolve(value));
}

function rejectObviouslyDangerousCommand(command: string): void {
  const blocked: Array<[RegExp, string]> = [
    [/\bsudo\b/i, "sudo is not allowed from Chat2Local chat tools"],
    [/\b(?:shutdown|reboot|halt)\b/i, "system shutdown commands are not allowed"],
    [/\bdiskutil\b[^\n]*(?:erase|partition|apfs delete)/i, "destructive disk commands are not allowed"],
    [/\bmkfs(?:\.|\s)/i, "filesystem formatting commands are not allowed"],
    [/\brm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\s+\/(?:\s|$)/i, "broad root deletion is not allowed"],
  ];

  for (const [pattern, reason] of blocked) {
    if (pattern.test(command)) throw new Error(reason);
  }
}

function truncateOutput(value: string): string {
  if (value.length <= 120_000) return value;
  return value.slice(0, 120_000) + "\n… output truncated by Chat2Local …";
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
