import { isAbsolute, relative, resolve, sep } from "node:path";
import { redactWorkText } from "./work-log-redaction.js";

type Facts = Record<string, string | number | boolean | null>;
type ResultLike = { content: Array<{ type: string; text?: string }>; isError?: boolean };

/** An allowlist: payloads, URLs, expressions, commands and outputs never enter automatic history. */
export function workLogMetadata(root: string, tool: string, input: Record<string, unknown>): Facts {
  const result: Facts = {};
  if (typeof input.path === "string") result.path = safeRelativePath(root, input.path);
  if (typeof input.cwd === "string") result.cwd = safeRelativePath(root, input.cwd);
  if (tool === "local_dev_skills" && (input.action === "list" || input.action === "read")) {
    result.action = input.action;
    if (typeof input.id === "string") result.skillId = redactWorkText(input.id).slice(0, 160);
    if (typeof input.resource === "string") result.resource = redactWorkText(input.resource).slice(0, 160);
  }
  if (tool === "local_dev_browser_control" && typeof input.action === "string") result.action = input.action.slice(0, 30);
  for (const key of ["startLine", "endLine", "timeoutMs", "offset", "limit"] as const) {
    if (typeof input[key] === "number" && Number.isFinite(input[key])) result[key] = input[key];
  }
  if (typeof input.replaceAll === "boolean") result.replaceAll = input.replaceAll;
  return result;
}

function safeRelativePath(root: string, path: string): string {
  const inside = relative(resolve(root), isAbsolute(path) ? resolve(path) : resolve(root, path));
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return "[outside selected folder]";
  return redactWorkText(inside || ".").slice(0, 512);
}

export function toolMayHaveSideEffects(tool: string, input: Record<string, unknown>): boolean {
  if (["local_dev_file_write", "local_dev_file_edit", "local_dev_shell", "local_dev_image_import", "local_dev_web_open"].includes(tool)) return true;
  if (tool === "local_dev_browser_inspect") return typeof input.url === "string";
  if (tool === "local_dev_browser_control") return input.action !== "activate";
  return false;
}

export function workLogResult(root: string, tool: string, returned: ResultLike): {
  status: "execution_recorded" | "execution_error"; result: Facts;
} {
  let value: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(returned.content.find(item => item.type === "text")?.text ?? "{}"); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as Record<string, unknown>; } catch { /* No raw fallback. */ }
  const result: Facts = {};
  for (const key of ["bytes", "replacements", "exitCode", "startLine", "endLine", "totalLines"] as const) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) result[key] = value[key];
  }
  if (typeof value.path === "string") result.path = safeRelativePath(root, value.path);
  if (typeof value.truncated === "boolean") result.truncated = value.truncated;
  if (tool === "local_dev_skills" && Array.isArray(value.skills)) result.skillCount = value.skills.length;
  const failed = returned.isError === true || (tool === "local_dev_shell" && typeof value.exitCode === "number" && value.exitCode !== 0);
  return { status: failed ? "execution_error" : "execution_recorded", result };
}
