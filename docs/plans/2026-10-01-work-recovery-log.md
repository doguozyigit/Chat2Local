# Work Recovery Log Implementation Plan

> **For implementation:** Use the executing-plans skill to implement this plan task by task, with tests for the interruption and access boundaries.

**Goal:** Preserve enough work history and task context to resume local work safely after a crash, disconnect, or closed conversation.

**Architecture:** Add a durable operation journal and small model-authored checkpoints to Local Dev's existing private SQLite storage. Scope access to the requesting chat and its current folder revision. Expose a compact recovery summary through existing setup/status responses, one scoped work-log tool, and an on-demand native history view.

**Tech Stack:** TypeScript, Node.js 24 built-in SQLite, the existing MCP server, SwiftUI, and current scoped file tools.

---

## Proposed interpretation and boundaries

The approved interpretation of “prevent disruption” is preserving progress and helping the user recover unfinished work. The design supports recovery and troubleshooting with compact records. It cannot prevent ChatGPT from ending a turn, preserve reasoning never sent to Local Dev, or make a closed chat restart itself.

Manual folder selection remains the access grant. Multiple chats may still select one folder. Work records do not introduce workers, primaries, desktop conversation links, automatic continuation, or silent message sending.

Implementation is included in the source. Disposable interruption checks and release verification are recorded in the final verification report; no live chat or project was used for acceptance tests.

## Evidence collected before implementation

- `apps/daemon/src/chat-folder-store.ts` persists folder connections with owner-only database permissions and `synchronous=FULL`; active tool scopes are held in memory.
- `apps/daemon/src/mcp.ts` has a shared `scoped()` wrapper suitable for recording authenticated tool execution. Skill checks are currently in memory and must be repeated after restart.
- `apps/daemon/src/tunnel-manager.ts` has connection diagnostics, but there is no durable task history or recovery checkpoint.
- `apps/daemon/src/local-tools.ts` truncates a target before writing its replacement. An interruption at that point can leave partial contents.
- Shell commands can continue after a transport disconnect; command completion and message receipt are different facts.
- The native app polls `/v1/status`. Its existing chat cards have no work history view, and its bundled-daemon launcher currently has no crash recovery monitor.

## Approach comparison

| Approach | What it preserves | Trade-off |
| --- | --- | --- |
| Diagnostic log only | Errors and connection failures | Insufficient task intent for resuming work |
| One project Markdown note | Goal and next steps | Depends on model updates; automatically shared with other chats using the folder |
| Private journal plus checkpoints — recommended | Actual tool attempts, outcomes, goal, progress, and next step | One scoped tool and a small history view |

Use the third approach. Offer an explicit copy/export action for a human-readable handoff; do not automatically write private chat history into a project or repository.

## Recovery contract

### Automatic records

Each operation has a daemon-generated UUID, increasing sequence, daemon run ID, chat ID, folder revision, tool name, start/end time, and bounded safe metadata. Start is durably recorded before a side effect. No SQL transaction stays open while awaiting a tool.

Persist terminal outcomes as `execution_recorded` or `execution_error`, with a result category such as success, nonzero exit, timeout, or cancellation. Previous-run starts without terminal records become `outcome_unknown` on startup. A handled error may still have side effects, so the record also indicates whether an operation can have changed state.

These states describe local execution. They never claim that ChatGPT received the response. Do not use a `delivered` state without a real host acknowledgement.

### Task checkpoints

The proposed `local_dev_work_log` tool has `read` and `checkpoint` actions. Checkpoints contain bounded fields:

```ts
type WorkCheckpoint = {
  goal: string;
  completed: string[];
  verification: string[];
  nextStep: string;
  status: "in_progress" | "blocked" | "completed";
};
```

The checkpoint is the model's description of the task, not independent proof of completion. Link it to the journal sequence so subsequent actions reveal when a checkpoint has become stale. Skill guidance asks the model to checkpoint before beginning changes, after meaningful milestones, after verification, and before its final response. Do not depend on a token threshold that Local Dev cannot measure reliably.

### Recovery behavior

On the next setup/status call after an interruption, return a small recovery hint with the latest current-scope checkpoint, activity since that checkpoint, and uncertain operations. Read the detailed log on demand.

The model inspects current files and verification evidence before proceeding. A started write or command without a recorded result is never automatically repeated. Read-only inspection remains available. Outstanding uncertain side effects require an explicit recorded review before new side effects proceed; that review is an acknowledgement of inspection, not an exactly-once or delivery guarantee.

If a new chat is used, the user selects its folder normally and explicitly copies the recovery summary into it. Chats sharing a folder have separate private histories. Changing or disconnecting a folder prevents the chat from reading the old revision's records through MCP; the owner can inspect historical revisions in the native app.

## Task 1: Durable journal and checkpoint storage

**Files:**
- Create: `apps/daemon/src/work-log-store.ts`
- Create: `apps/daemon/src/work-log-store.test.ts`
- Modify: `apps/daemon/src/chat-folder-store.ts`
- Modify: `apps/daemon/src/index.ts`
- Modify: `packages/protocol/src/index.ts`

1. Write failing tests for reopen persistence, per-chat/revision isolation, increasing sequence, prior-run unfinished operations, and bounded checkpoint fields.
2. Implement additive journal/checkpoint tables using the existing private database connection; keep folder grants and existing rows intact. Let the folder store own connection lifetime.
3. Record daemon startup/shutdown. Do not declare pending operations failed just because a transport closes or shutdown begins.
4. Add bounded retention: keep the latest checkpoint and unresolved records; prune completed history after 30 days or beyond a documented row/byte budget. If safe pruning cannot make space, report the storage problem instead of discarding unresolved recovery evidence.
5. Verify persistence and migration using disposable SQLite files. No tests use the user's application database.

Run: `npm run build && node --test apps/daemon/dist/work-log-store.test.js`

Expected: storage tests pass, and existing folder-store tests still pass without permission changes.

## Task 2: Automatic tool records

**Files:**
- Modify: `apps/daemon/src/mcp.ts`
- Modify: `apps/daemon/src/mcp.test.ts`
- Create: `apps/daemon/src/work-log-metadata.ts`
- Create: `apps/daemon/src/work-log-metadata.test.ts`

1. Instrument `scoped()` only after trusted host metadata and a valid folder scope have been resolved. Never accept a caller-supplied chat ID or use an MCP transport session as identity.
2. Use per-tool metadata allowlists: relative target paths, action names, skill catalog IDs/names, sizes/counts, exit codes, and safe error categories. Classify mutating browser actions, image imports, and saved screenshots as potential side effects too.
3. Do not store raw file contents, replacement text, command strings, stdout/stderr, browser typing/evaluation text, URL queries, image download URLs, request headers, credentials, or raw host identifiers.
4. Persist operation start before execution. If that write fails, refuse a side effect with a clear storage error; allow inspection where possible.
5. Record actual result semantics. In particular, shell exit code 1 must not look like success merely because its MCP envelope is normal.
6. If result logging fails after execution, preserve the actual execution result and attach a recovery-record warning. Do not turn a successful side effect into a generic error that encourages blind replay.

Expected: authenticated actions produce durable compact events; representative secrets never appear in journal rows; transport loss does not imply that a command stopped.

## Task 3: Checkpoints and resumption guidance

**Files:**
- Modify: `apps/daemon/src/mcp.ts`
- Modify: `apps/daemon/src/mcp.test.ts`
- Modify: `plugin/local-dev/skills/local-dev/SKILL.md`
- Modify: `plugin/local-dev/scripts/mcp-stdio-bridge.test.mjs`
- Modify: `scripts/fresh-install-check.mjs`
- Modify: `docs/TOOLS.md`
- Modify: `docs/PROJECT_SETUP.md`

1. Add the strict, current-scope `local_dev_work_log` tool and bounded/paginated reads. Bound checkpoint text to 8 KiB total and apply common credential redaction; automatic records avoid sensitive payloads by construction.
2. Extend setup/status with a small recovery summary, never a complete event dump. Return no prior-folder or other-chat checkpoint.
3. Add checkpoint-before-first-change guidance and a deterministic initial gate similar to the existing skill check. It applies at a new folder revision or after restart. A model must read recovery information when present before acknowledging that gate.
4. Require explicit review of uncertain side effects before further side effects, while permitting file/status inspection. Keep recovery records as historical context subject to the current user's request.
5. Update the Local Dev workflow to checkpoint at useful milestones, compare current files with the last record, re-list/read relevant skills after restart, and finish with a checkpoint describing verified results and remaining work.
6. Update the exact tool inventories: this introduces one work-log tool, not any removed orchestration tools. Refreshing the ChatGPT connection will be required after implementation.

Expected: a resumed chat sees useful progress and checks uncertain work before changing files. A new chat receives no other chat's private log unless the user explicitly provides a recovery summary.

## Task 4: Safer direct file saving

**Files:**
- Modify: `apps/daemon/src/local-tools.ts`
- Modify: `apps/daemon/src/local-tools.test.ts`
- Create: `apps/daemon/src/atomic-scoped-write.test.ts`

1. Add a subprocess crash test around direct file writes and edits. The current truncate-then-write behavior should expose the concrete interruption risk.
2. Stage the complete replacement in the same validated directory, flush it, then replace the target atomically and flush directory metadata where supported. Preserve the intended file permissions.
3. Preserve and extend containment checks for escaping symlinks, directory swaps, invalid file types, and changed target identities. Audit the rename path carefully before replacing the existing helper.
4. Serialize Local Dev writes to the same canonical target across chats and reject detected conflicting changes. This does not promise conflict protection against every external editor or arbitrary shell command.
5. On restart, identify only Local Dev's own abandoned staging files through recorded operations. Do not scan/delete unrelated temporary files or silently roll back completed changes.

Expected: killing the process during a direct save leaves either the previous complete file or the new complete file, never a truncated replacement; all existing scope tests remain green.

Shell commands and external actions can have their own partial effects. The log supports inspection of those effects; it is not a whole-project backup or transaction system.

## Task 5: Small native recovery view

**Files:**
- Modify: `apps/daemon/src/http.ts`
- Modify: `apps/daemon/src/http.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/macos/Sources/LocalDevMenuBar/Models.swift`
- Modify: `apps/macos/Sources/LocalDevMenuBar/AppModel.swift`
- Modify: `apps/macos/Sources/LocalDevMenuBar/Views.swift`
- Modify: `apps/macos/Tests/ChatFolderModelsCheck.swift`

1. Add owner-authenticated paginated history/checkpoint endpoints with the existing token, Host, Origin, and local-only checks.
2. Put a compact “Last saved” / “Review interrupted work” indicator in the existing chat card. Load detailed history only when opened, not in the two-second status polling loop.
3. Offer **View work log**, **Copy recovery summary**, and **Clear completed history**. Historical folder revisions stay explicitly labelled; they do not grant the model access to that folder.
4. Keep copy/export a deliberate native user action and exclude credentials/raw payloads. Clearing completed history preserves pending and unreviewed failed/uncertain records and the latest checkpoint.
5. Detect a crashed bundled daemon and show **Restart Local Dev service**. Prefer this explicit first version over a restart loop that repeatedly interrupts tools. A restarted service restores records and reports uncertainty rather than rerunning work.

Expected: the owner can understand what happened and restart/recover through the existing window. No chat window is opened or message sent.

## Task 6: Interruption acceptance and release updates

**Files:**
- Create: `scripts/work-recovery-check.mjs`
- Modify: `scripts/robustness-check.sh`
- Modify: `scripts/fresh-install-check.mjs`
- Modify: `docs/RELEASE_CHECK.md`
- Modify: `SECURITY.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

Use disposable app state and a separate port. Test:

1. Checkpoint, successful write, forced service kill, restart, and read recovery information.
2. Kill during a direct file save and after replacement but before journal completion; verify complete file contents and an uncertain result where necessary.
3. Drop a transport response after a completed operation; retain execution evidence without claiming delivery or rerunning it.
4. Interrupt a shell command and inspect whether the command/descendants have actually stopped before deciding to retry.
5. Exercise start-record failure, finish-record failure, timeout, nonzero exit, retention, and checkpoint staleness.
6. Confirm two chats sharing a folder cannot read one another's private records; changing folders cannot restore an old scope.
7. Confirm logs contain no representative credentials or raw sensitive payloads and remain absent from source/npm exports.
8. Verify the recovery badge, history view, copy action, and manual service restart in the Mac UI.

Run the focused checks first, then `npm run robustness`. Build the app and run packaged acceptance once the recovery tests pass. Regenerate release artifacts and verification reports after implementation. No publication occurs as part of this plan.

## Success criteria

- A service restart preserves the last checkpoint and recorded actions.
- The user and model can distinguish recorded execution, failure, and uncertain outcome.
- Direct file saves resist a crash without exposing files outside the selected folder.
- Recovery does not automatically repeat potentially completed actions or expose another chat's private history.
- The interface remains centred on chats, folders, tools, and skills.
- A new conversation can continue from an explicitly copied summary after manual folder selection.

## Known limits

Useful checkpoint prose depends on model cooperation; a catalog check or checkpoint gate cannot prove that every instruction was followed. Work done wholly outside Local Dev is not observed. The log does not wake a closed chat, restore unsent chat text, guarantee host receipt, back up the whole project, or undo arbitrary shell/browser effects.

The repository currently has no Git metadata. Save this plan as a source file; do not invent a repository or create commits. Once the user establishes a repository, implementation changes can be committed in reviewable steps.

## Implementation verification — 2026-10-01

Implemented the private work log and checkpoints, mutation/review gates, atomic direct text saves with recorded staging identity, native history/recovery controls, explicit service restart, and workflow documentation. Added an exclusive daemon state lock so a second process cannot misclassify a running process's unfinished actions as interrupted.

- Full robustness gate: 218 automated tests passed (141 daemon tests and 77 bridge, script, and installer tests), plus the native build and six standalone native checks.
- Packaged empty-state acceptance: 16 checks passed.
- Packaged crash and dropped-response acceptance: five checks passed; execution evidence persisted without automatic replay.
- Real process-kill checks covered direct-save stages and journal recovery; storage fault tests covered start, stage, and final-history failures.
- Live Mac UI click-through remains unverified: the computer-use inspection timed out on the disposable test app. The production app was not stopped, and no real chat or project was used for acceptance.

Release artifacts and detailed results are generated under `dist`. No repository, commit, hosted release, or npm publication was created.
