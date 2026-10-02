import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

/** Write browser output into the caller's project without following a filename symlink. */
export async function writeScopedArtifact(
  projectRoot: string,
  prefix: string,
  extension: "json" | "png",
  bytes: Uint8Array | string,
): Promise<string> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(prefix)) {
    throw new Error("Invalid artifact name.");
  }
  if (extension !== "json" && extension !== "png") {
    throw new Error("Unsupported artifact extension.");
  }

  const root = await realpath(projectRoot);
  const requestedDirectory = join(root, ".tmp");
  try {
    await mkdir(requestedDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  // Resolve the directory before constructing the output path. This also catches
  // an existing .tmp symlink whose destination has escaped the project.
  const directory = await realpath(requestedDirectory);
  const withinRoot = relative(root, directory);
  if (
    withinRoot === ""
    || withinRoot === ".."
    || withinRoot.startsWith(`..${sep}`)
    || isAbsolute(withinRoot)
  ) {
    throw new Error("Artifact directory escapes the Chat2Local project scope.");
  }
  if (!(await stat(directory)).isDirectory()) {
    throw new Error("Artifact directory is not a directory.");
  }

  const path = join(directory, `${prefix}-${randomUUID()}.${extension}`);
  const handle = await open(
    path,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
  return path;
}
