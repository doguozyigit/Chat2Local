# Chat2Local tools

All project actions use the current chat's manually selected folder. A new chat must select a folder even if another chat already uses it.

| Action | Purpose |
| --- | --- |
| `local_dev_project_setup` | Discover this chat, return its setup code, and check folder selection. |
| `local_dev_status` | Report the current chat's connection and service state. |
| `local_dev_capabilities` | Describe available tools and access. |
| `local_dev_file_read` | Read a text file, optionally by line range. |
| `local_dev_file_write` | Write a text file. |
| `local_dev_file_edit` | Replace matching text in a file. |
| `local_dev_list` | List a directory inside the folder. |
| `local_dev_search` | Search text inside the folder. |
| `local_dev_shell` | Run a bounded command from the folder. |
| `local_dev_skills` | List or read installed and project skill guidance. |
| `local_dev_work_log` | Read this chat's recovery history and save a task checkpoint. |
| `local_dev_browser_inspect` | Inspect this chat's background browser page. |
| `local_dev_browser_control` | Navigate or interact with that background page. |
| `local_dev_web_open` | Read a known web page. |
| `local_dev_image_import` | Save an image explicitly supplied by the chat. |

## Skills

The catalog covers project skills and installed Codex, agents, and plugin skills. List before the first write, edit, image import, or shell command after connecting a folder or restarting Chat2Local. Read the relevant guide using its opaque ID; use the next offset for more catalog pages and the resource parameter for a referenced skill file.

Chat2Local verifies the catalog check occurred. It cannot judge whether the model applied every instruction. Skill text does not grant additional tools or access to folders.

## Work log and checkpoints

Use `local_dev_work_log` with `action: "read"` before the first change and when resuming work. It returns the current folder revision, latest checkpoint, recovery summary, and events in newest-first order. Read accepts `limit` from 1 to 200 (default 50) and `beforeSequence`; pass `nextBeforeSequence` from a response to read an older page. Model tools cannot select a different chat or historical folder revision. The Mac app can show the owner's archived history without granting model access to that folder.

Use `action: "checkpoint"` with a `checkpoint` object:

| Field | Meaning |
| --- | --- |
| `goal` | Concise task goal; 1–2,000 characters. |
| `completed` | Completed steps; up to 30 entries of 1,000 characters each. |
| `verification` | Checks actually performed; up to 30 entries of 1,000 characters each. |
| `nextStep` | Concrete next action or completion note; 1–2,000 characters. |
| `status` | `in_progress`, `blocked`, or `completed`. |

The serialized checkpoint must also fit the 8 KiB storage limit. Keep prose brief and omit credentials, raw file contents, commands, browser text, and tool output. Common secret patterns are redacted, but this does not guarantee that prose contains no sensitive information.

Before writes, edits, imports, commands, or browser actions that may have effects, Chat2Local requires a checkpoint for the current chat and folder revision in the current service run. Existing history must be read before saving a checkpoint. Update the checkpoint after meaningful milestones, failures, and completion. `completed` closes the checkpoint gate; subsequent changes need a new checkpoint. A checkpoint is task context supplied by the model, not proof that work was verified.

Events distinguish `started`, `execution_recorded`, `execution_error`, and `outcome_unknown`. Recorded execution does not establish that ChatGPT received the result. After a failed or uncertain action with possible side effects, further changes are blocked until the model reads the relevant events, inspects actual files or command/browser effects, and submits a checkpoint with `reviewedOperationIds` and `reviewNote`. IDs must be UUIDs from history read during this service run, with up to 50 per request; the note must be 1–1,000 characters. Reading remains available for inspection. Reviewing an event acknowledges inspection and keeps its original outcome; it does not turn uncertainty into success or undo effects. Do not replay an action merely because its response was lost.

For example, after reading history and checking relevant skills:

```json
{
  "action": "checkpoint",
  "checkpoint": {
    "goal": "Finish the project notes",
    "completed": ["Reviewed the existing notes"],
    "verification": ["Read the saved draft"],
    "nextStep": "Update the headings",
    "status": "in_progress"
  }
}
```

Automatic history stores bounded facts such as relative paths, action names, byte counts, and exit codes. It excludes raw commands, URLs, file/page contents, screenshots, and stdout/stderr. If a start record cannot be saved, an action with possible effects does not begin; a failed finish record leaves the outcome uncertain. See [work recovery](WORK_RECOVERY.md) for native controls, retention, and limits.

## Scope

Use paths relative to the selected folder. Reads and changes reject paths outside its scope, including escaping symlinks. Shell commands are bounded and scoped. The background browser has a separate profile per chat and does not control the visible desktop or reuse personal browser cookies.

Tools report actual outcomes. Check files and meaningful validation before claiming the user's work is finished.
