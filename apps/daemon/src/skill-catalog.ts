import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_SKILL_BYTES = 256 * 1024;
const METADATA_BYTES = 8192;
const MAX_SCAN_DIRECTORIES = 10_000;
const MAX_CATALOG_SKILLS = 2_000;
// Darwin's sys/fcntl.h defines O_NOFOLLOW_ANY as 0x20000000. Unlike
// O_NOFOLLOW, it rejects symlinks in every pathname component at open time.
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".csv",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".sh", ".sql",
  ".html", ".css", ".xml", ".svg", ".swift", ".rs", ".go",
]);

export type SkillSource = "project" | "codex" | "agents" | "plugin";

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
}

interface CatalogEntry extends SkillSummary {
  directory: string;
  catalogRoot: string;
}

interface RootSpec {
  path: string;
  source: SkillSource;
  boundary: string;
}

export class SkillCatalog {
  private readonly codexHome: string;
  private readonly agentsSkillsRoot: string;

  constructor(options: { codexHome?: string; agentsSkillsRoot?: string } = {}) {
    this.codexHome = resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
    this.agentsSkillsRoot = resolve(options.agentsSkillsRoot ?? join(homedir(), ".agents", "skills"));
  }

  async list(
    projectPath: string,
    options: { query?: string; offset?: number; limit?: number } = {},
  ): Promise<{ skills: SkillSummary[]; total: number; nextOffset: number | null }> {
    const query = (options.query ?? "").trim().toLocaleLowerCase();
    if (query.length > 120) throw new Error("Skill query is too long (120 character limit).");
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Skill offset must be a nonnegative integer.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Skill limit must be between 1 and 50.");

    const matching = (await this.discover(projectPath)).filter((skill) =>
      !query || `${skill.name} ${skill.description} ${skill.source}`.toLocaleLowerCase().includes(query)
    );
    const skills = matching.slice(offset, offset + limit).map(({ id, name, description, source }) => ({
      id, name, description, source,
    }));
    return {
      skills,
      total: matching.length,
      nextOffset: offset + skills.length < matching.length ? offset + skills.length : null,
    };
  }

  async read(
    projectPath: string,
    id: string,
    resource?: string,
  ): Promise<{ skill: SkillSummary; resource: string; content: string; bytes: number }> {
    if (!/^skill_[A-Za-z0-9_-]{27}$/.test(id)) throw new Error("Unknown skill ID in this chat's catalog.");
    const entry = (await this.discover(projectPath)).find((skill) => skill.id === id);
    if (!entry) throw new Error("Unknown skill ID in this chat's catalog.");
    const selected = resource === undefined ? "SKILL.md" : validateResource(resource);
    const filePath = join(entry.directory, ...selected.split("/"));
    if (!isWithin(entry.directory, filePath)) {
      throw new Error("Skill resource path leaves its skill directory.");
    }
    const { content } = await readVerifiedText(entry.catalogRoot, filePath, MAX_SKILL_BYTES);
    const { directory: _directory, catalogRoot: _catalogRoot, ...skill } = entry;
    return { skill, resource: selected, content, bytes: Buffer.byteLength(content, "utf8") };
  }

  private async discover(projectPath: string): Promise<CatalogEntry[]> {
    const project = resolve(projectPath);
    const specs: RootSpec[] = [
      { path: join(project, ".codex", "skills"), source: "project", boundary: project },
      { path: join(project, ".agents", "skills"), source: "project", boundary: project },
      { path: join(project, "skills"), source: "project", boundary: project },
      { path: join(project, "plugin"), source: "project", boundary: project },
      { path: join(project, "plugins"), source: "project", boundary: project },
      { path: join(this.codexHome, "skills"), source: "codex", boundary: this.codexHome },
      { path: this.agentsSkillsRoot, source: "agents", boundary: this.agentsSkillsRoot },
      { path: join(this.codexHome, "plugins", "cache"), source: "plugin", boundary: this.codexHome },
    ];
    const entries: CatalogEntry[] = [];
    for (const spec of specs) {
      if (entries.length >= MAX_CATALOG_SKILLS) break;
      const root = await canonicalRoot(spec);
      if (!root) continue;
      await scanRoot(root, spec.source, entries);
    }
    entries.sort((a, b) =>
      a.name.localeCompare(b.name) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id)
    );
    return entries;
  }
}

async function canonicalRoot(spec: RootSpec): Promise<string | null> {
  try {
    const info = await lstat(spec.path);
    if (!info.isDirectory()) return null;
    const [root, boundary] = await Promise.all([realpath(spec.path), realpath(spec.boundary)]);
    return isWithin(boundary, root) ? root : null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function scanRoot(root: string, source: SkillSource, found: CatalogEntry[]): Promise<void> {
  const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  let visited = 0;
  while (pending.length && visited < MAX_SCAN_DIRECTORIES && found.length < MAX_CATALOG_SKILLS) {
    const current = pending.pop()!;
    visited += 1;
    if (current.depth > 12) continue;
    let items;
    try {
      items = await readdir(current.directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error) || isDenied(error)) continue;
      throw error;
    }
    const skillFile = items.find((item) => item.name === "SKILL.md" && item.isFile());
    if (skillFile) {
      const file = join(current.directory, "SKILL.md");
      try {
        const { content: excerpt, canonicalPath } = await readVerifiedText(root, file, METADATA_BYTES, true);
        const meta = parseMetadata(excerpt, basename(current.directory));
        found.push({
          id: `skill_${createHash("sha256").update(`${source}\0${canonicalPath}`).digest("base64url").slice(0, 27)}`,
          name: meta.name,
          description: meta.description,
          source,
          directory: current.directory,
          catalogRoot: root,
        });
      } catch (error) {
        // A skill can disappear or change while the catalog is scanned. Skip
        // that entry rather than exposing an unverified file or losing the
        // rest of the catalog.
        continue;
      }
    }
    if (current.depth >= 12) continue;
    for (const item of items) {
      if (!item.isDirectory() || ["node_modules", ".git", "dist", ".build", ".cache", ".tmp"].includes(item.name)) continue;
      pending.push({ directory: join(current.directory, item.name), depth: current.depth + 1 });
    }
  }
}

function parseMetadata(content: string, fallback: string): { name: string; description: string } {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return { name: fallback.slice(0, 120), description: "" };
  const lines = match[1]!.split(/\r?\n/);
  const field = (key: string): string => {
    const line = lines.find((candidate) => candidate.startsWith(`${key}:`));
    const value = line?.slice(key.length + 1).trim() ?? "";
    return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2").replace(/\s+/g, " ");
  };
  return {
    name: (field("name") || fallback).slice(0, 120),
    description: field("description").slice(0, 240),
  };
}

function validateResource(resource: string): string {
  if (!resource || resource.length > 240 || resource.includes("\\") || resource.includes("\0") || isAbsolute(resource)) {
    throw new Error("Skill resource must be a short relative text path.");
  }
  const segments = resource.split("/");
  if (segments.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Skill resource path traversal is not allowed.");
  }
  if (!TEXT_EXTENSIONS.has(extname(resource).toLocaleLowerCase())) {
    throw new Error("Skill resource must have a supported text extension.");
  }
  return resource;
}

async function assertRegularFileWithoutSymlinks(root: string, path: string) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error("Skill catalog root changed during read.");
  }
  const parts = relative(root, path).split(sep);
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Skill resource path leaves its skill directory.");
  }
  let current = root;
  let fileInfo;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("Skill resource symlinks are not allowed.");
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error("Skill resource path is not a directory.");
    if (index === parts.length - 1 && !info.isFile()) throw new Error("Skill resource is not a regular text file.");
    if (index === parts.length - 1) fileInfo = info;
  }
  return fileInfo!;
}

async function readVerifiedText(
  root: string,
  path: string,
  limit: number,
  excerpt = false,
): Promise<{ content: string; canonicalPath: string }> {
  const before = await assertRegularFileWithoutSymlinks(root, path);
  const canonicalPath = await realpath(path);
  if (!isWithin(root, canonicalPath)) throw new Error("Skill resource path leaves its catalog root.");
  // Darwin rejects combining O_NOFOLLOW_ANY with O_NOFOLLOW (EINVAL).
  const noFollowFlags = constants.O_RDONLY |
    (process.platform === "darwin" ? DARWIN_O_NOFOLLOW_ANY : (constants.O_NOFOLLOW ?? 0));
  const handle = await open(path, noFollowFlags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("Skill resource changed before it could be opened safely.");
    }
    const after = await assertRegularFileWithoutSymlinks(root, path);
    const afterCanonical = await realpath(path);
    if (!isWithin(root, afterCanonical) || afterCanonical !== canonicalPath ||
        opened.dev !== after.dev || opened.ino !== after.ino) {
      throw new Error("Skill resource path changed during read.");
    }
    if (!excerpt && opened.size > limit) throw new Error(`Skill resource is too large (${limit / 1024} KiB limit).`);
    const size = Math.min(opened.size, limit);
    const buffer = Buffer.alloc(size);
    let bytes = 0;
    while (bytes < size) {
      const read = await handle.read(buffer, bytes, size - bytes, bytes);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
    }
    return { content: buffer.subarray(0, bytes).toString("utf8"), canonicalPath };
  } finally {
    await handle.close();
  }
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}
