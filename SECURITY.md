# Security and privacy

Chat2Local grants each chat access to one folder selected by the user in the native app. A model request cannot choose a folder or switch to another chat. Requests without trusted per-chat metadata are rejected. Multiple chats can select the same folder and edit the same files.

## Boundaries

- File tools reject paths and symlinks that escape the selected folder.
- Shell commands run with time limits and a project working directory. On macOS they use the system sandbox profile implemented in `apps/daemon/src/local-tools.ts`. Commands may execute project code and use the network; this is not a container or virtual machine. Other systems do not provide equivalent process isolation through working-directory checks. The native app is supported on macOS.
- Browser tools use separate profiles and do not reuse personal cookies. Pages and repository files are untrusted input.
- Installed skills are readable outside the project through the skills tool's restricted catalog. They do not grant arbitrary access to parent folders.
- A catalog check gates file writes, edits, image imports, and commands. A checkpoint gates actions that may have effects in each service run and folder revision. Chat2Local cannot prove the model followed skill instructions or inspected the state described in a checkpoint.

The local control and MCP APIs accept authenticated loopback requests with strict Host and Origin checks. The API token is owner-only; saved tunnel credentials use macOS Keychain. These protections do not isolate Chat2Local from other software running as the same user.

## Data

Chat2Local stores chat labels, connection metadata, selected paths, browser profiles, and tunnel diagnostics on this Mac. Tool responses can include requested file contents, skill text, page content, and screenshots sent to ChatGPT. Choose a folder whose contents you intend the chat to access. The service does not upload the whole folder automatically.

Checkpoints and recovery events use the owner-only `~/.local-dev/chat-folders.sqlite` database. Recovery reads through MCP are scoped to the current chat and folder revision, including when multiple chats share files. Authenticated native owner controls can read archived revisions; historical context does not restore a folder grant. Source and npm exports exclude this runtime database and other private state.

Automatic journal entries contain only bounded, allowlisted execution facts, such as relative paths, action names, byte counts, and exit codes. They exclude raw file and page contents, shell commands, URLs, browser input and expressions, screenshots, stdout/stderr, and credential payloads. Model-authored checkpoints and review notes receive common secret-pattern redaction; it cannot guarantee that arbitrary prose is free of secrets. Keep this prose concise and avoid sensitive material. Copied recovery text also receives common-pattern redaction across titles, folder paths, and checkpoint prose; review it before sharing. A recovery summary reaches the clipboard only when the user clicks **Copy recovery summary**; the user controls any later sharing.

Eligible completed or explicitly reviewed events have a 30-day retention policy and a 10,000-event limit per chat/folder revision. Global budgets cover 50,000 accounted records and 32 MiB of accounted recovery payload, with earlier eviction of eligible events when needed. These are accounting limits, not a 32 MiB cap on the SQLite file, its journal, or total runtime state. Pending events, unreviewed failed/uncertain events, and the latest checkpoint are protected. A full store can refuse further operations rather than discard protected evidence; **Clear completed history** preserves those protected records.

An operation with possible effects is refused if its start record cannot be saved. If its finish record fails, the action may already have happened and its outcome is treated as uncertain. Restarting the service marks unfinished records uncertain. Failed or uncertain actions with possible effects require explicit inspection and review before further changes. An execution record proves neither host receipt nor safe repetition. Chat2Local does not automatically replay operations, send messages, open or wake chats, or create workers or chat bindings.

Direct text writes and edits use atomic file replacement within the selected folder to resist incomplete saves during a service interruption. This does not cover files written by arbitrary shell commands or browser/image artifact generation, preserve earlier versions, back up the project, or roll back external effects. See [work recovery](docs/WORK_RECOVERY.md) for the manual workflow.

## Reporting a problem

For a non-sensitive bug report, include the version, macOS version, affected action, and a redacted error. Do not attach runtime state, Keychain exports, browser profiles, runtime keys, API tokens, or private project files. Avoid posting exploitable issues or credentials publicly; contact the maintainer privately when a private channel is available.

`npm run release:check` scans the proposed source inventory for selected secret patterns and unsafe files. It does not audit dependency vulnerabilities or guarantee the absence of secrets. Review the inventory and new files before publishing.

Native app packaging strips debug symbols before signing to remove the builder's local source paths. Desktop release packaging also rejects personal home paths in the app executable. This check does not remove third-party runtime build metadata or replace a content review. Share the explicitly exported source or prepared release archive; uploading the whole development folder can include private state, profiles, diagnostics, and temporary files.

## Installer downloads

The npm command installs only when invoked explicitly. Production app downloads use HTTPS, bounded transfer limits, and pinned size/SHA-256 checks from the package's release manifest. Archive extraction rejects escaping paths, links, duplicate names, invalid checksums, and unsupported formats. The Mac bundle is checked for its identifier, version, processor architecture, and code signature before installation.

A custom `--manifest-url` delegates release trust to the publisher of that manifest. Its hashes establish that the bytes match the manifest; they are not an independent proof of publisher identity. Local fixture validation requires both an explicit manifest file and an archive file. The installer does not access saved API keys, selected folders, or projects. It refuses to overwrite a different app and does not disable Gatekeeper or change certificate trust. Ad hoc development signatures do not replace Apple's public distribution checks.
