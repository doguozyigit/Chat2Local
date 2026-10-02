import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export type ProjectFolderReason = "project_folder_not_selected" | "project_path_not_absolute"
  | "project_folder_missing" | "project_path_not_directory" | "project_folder_unavailable";

export type ProjectFolderResult =
  | { ok: true; projectPath: string }
  | { ok: false; code: "project_folder_required" | "invalid_project_folder";
      reasonCode: ProjectFolderReason; nextAction: string };

/** Resolve only an existing, usable directory. Selecting or creating one is a UI action. */
export async function resolveProjectFolder(requestedPath?: string): Promise<ProjectFolderResult> {
  const invalid = (reasonCode: ProjectFolderReason): ProjectFolderResult => ({
    ok: false,
    code: reasonCode === "project_folder_not_selected" ? "project_folder_required" : "invalid_project_folder",
    reasonCode,
    nextAction: "Open Chat2Local and select an existing folder for this chat, then resume the chat.",
  });
  if (requestedPath === undefined || requestedPath.trim().length === 0) return invalid("project_folder_not_selected");
  if (!isAbsolute(requestedPath)) return invalid("project_path_not_absolute");
  try {
    const projectPath = await realpath(requestedPath);
    if (!(await stat(projectPath)).isDirectory()) return invalid("project_path_not_directory");
    await access(projectPath, constants.R_OK | constants.W_OK | constants.X_OK);
    return { ok: true, projectPath };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return invalid(code === "ENOENT" ? "project_folder_missing"
      : code === "ENOTDIR" ? "project_path_not_directory" : "project_folder_unavailable");
  }
}
