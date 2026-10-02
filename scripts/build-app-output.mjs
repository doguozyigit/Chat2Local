#!/usr/bin/env node
import { lstat, realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** A build deletes its old output; keep that operation inside a known dist tree. */
export async function resolveAppOutput(repositoryRoot, requested) {
  const root = await realpath(repositoryRoot), dist = join(root, "dist");
  const output = requested ? resolve(root, requested) : join(dist, "Chat2Local.app");
  const rel = relative(dist, output);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    throw new Error("The app build output must be inside the repository's dist directory.");
  }
  if (basename(output) !== "Chat2Local.app") throw new Error("The app build output must end in Chat2Local.app.");
  if (rel.split(sep).slice(0, -1).some(part => part.toLowerCase().endsWith(".app"))) {
    throw new Error("The app build output must be outside existing or legacy app bundles.");
  }
  let current = root;
  for (const part of relative(root, output).split(sep)) {
    current = join(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) throw new Error("The app build output and its parents must not contain a symlink.");
      if (!entry.isDirectory()) throw new Error("The app build output and its parents must be real directories.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(await resolveAppOutput(fileURLToPath(new URL("..", import.meta.url)), process.argv[2])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
