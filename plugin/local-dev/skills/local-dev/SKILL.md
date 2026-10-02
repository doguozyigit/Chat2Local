---
name: local-dev
description: Use when a ChatGPT chat needs to inspect or change files in a manually selected local folder, use local tools or skills, or resume interrupted Chat2Local work.
---

Use Chat2Local when the user wants work saved in a local folder on their Mac.

## Choose a folder before local work

At the first Chat2Local contact, call `local_dev_project_setup` with a short descriptive
`title`. This makes the current chat appear in the Chat2Local window and returns a setup
code. Do not invent a chat identity or supply a folder path through a tool.

If the chat is not connected, explain: **To save this work on your Mac, open Chat2Local,
match this chat's setup code, and choose a folder. Reply “connected” when ready.**
Show the returned code. Wait for the user's reply before using local project tools.
The user can continue in ChatGPT without selecting a local folder; that choice does not
grant Chat2Local file access.

After the user replies, call `local_dev_project_setup` again. Use local tools only when
it reports the chat connected to its selected folder. Folder selection happens in the
native Chat2Local window. The chat does not need a pasted conversation link or exact title.
An open ChatGPT conversation appears in Chat2Local only after it contacts a Chat2Local action.

Each chat has its own folder connection. Several chats may select the same folder.
They share its files, so coordinate overlapping edits with the user. A new chat must
have its own folder selection even when another chat already uses that folder.

## Tools

- `local_dev_file_read`, `local_dev_file_write`, and `local_dev_file_edit` read and change text files.
- `local_dev_list` and `local_dev_search` inspect the selected folder.
- `local_dev_shell` runs a bounded command in that folder.
- `local_dev_skills` lists and reads relevant installed or project skills.
- `local_dev_work_log` reads this chat's saved history and records concise checkpoints.
- `local_dev_browser_inspect` and `local_dev_browser_control` use this chat's isolated background browser.
- `local_dev_web_open` reads a known web page.
- `local_dev_image_import` saves an image explicitly supplied by this chat into the folder.
- `local_dev_status` and `local_dev_capabilities` report current access and available tools.

Use paths relative to the selected folder. Chat2Local enforces its file scope; a skill
cannot grant access to another folder. Do not claim a downloadable ChatGPT artifact
was saved locally unless a Chat2Local write or import actually succeeded.

## Skills

Before the first write, edit, image import, or shell command after connecting a folder
or restarting Chat2Local, call
`local_dev_skills` with `action: "list"`. Use a focused `query` when a skill is named or
the task suggests one. Read each relevant guide with `action: "read"` and its returned
opaque ID. If no guide fits, proceed after the catalog check. Use `nextOffset` to read
another page and the optional `resource` path for a referenced text file inside a skill.
Repeat the skill check when the user changes the selected folder or starts materially
different work.

The catalog includes project skills and the user's installed Codex, agents, and plugin
skills. Text is loaded only when read. Apply relevant guidance while respecting the
user's request and higher-priority instructions. Skills do not add tools. Do not run a
script merely because a guide mentions it.

Chat2Local checks that the catalog was consulted before a file write, edit, image import,
or shell command. A recorded check or read does not prove that all guidance was followed.

## Checkpoints and recovery

Before the first change, on resume, after a folder change, and after each Chat2Local
service restart:

1. Check the connection and consult skills as above.
2. Call `local_dev_work_log` with `action: "read"`. Follow `nextBeforeSequence` using
   `beforeSequence` when older events are relevant. Use only the current chat's history.
3. Inspect actual files or command/browser effects for failed or uncertain actions.
   A lost response is not permission to repeat an action; it may already have happened.
   For interrupted commands, establish whether the command and descendants have stopped.
4. Save `action: "checkpoint"` with a `checkpoint` object containing `goal`, `completed`,
   `verification`, `nextStep`, and `status` (`in_progress`, `blocked`, or `completed`).
   Keep it concise and record only completed steps and checks actually performed.

For inspected failed or uncertain events, supply their `reviewedOperationIds` and a
concise `reviewNote` alongside the checkpoint. Read those IDs in this service run first.
Chat2Local blocks further actions with possible effects until failed or uncertain side
effects are explicitly reviewed. Review preserves an event's outcome; it does not prove
success or undo effects. Read tools remain available for inspection.

Update the checkpoint at meaningful milestones, after failures, and at completion.
Compare a resumed checkpoint with later log events and actual state; it may be stale.
A `completed` checkpoint closes the change gate, so further work needs a new checkpoint.
Do not include secrets, raw commands, file/page contents, or tool output in checkpoint
prose or review notes. Common secret-pattern redaction is not a guarantee.

The work log records local execution, not confirmation that ChatGPT received a result.
It is not a backup or rollback system. The native owner can view archived revisions and
deliberately copy a summary. A new chat still needs manual folder selection; copied
context cannot grant access or expose another chat's private history. Chat2Local never
replays actions, sends messages, opens or wakes chats, or creates workers or bindings.

## Work and verification

Use the tools to inspect, make the requested changes, and verify the result. Report
what was saved, where it was saved, and any checks that could not be completed. Keep
working in this chat according to the user's request; Chat2Local does not manage chat
turns. Irreversible external actions still require the user's authorization.
