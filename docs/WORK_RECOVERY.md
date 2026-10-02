# Recover interrupted work

Chat2Local saves a task checkpoint and a private record of local tool execution for each chat and folder revision. These records survive a service restart and help the assistant compare planned work with actual files and actions.

## Continue in the same chat

1. Open Chat2Local. If its bundled service crashed, choose **Restart Chat2Local service**.
2. Find the chat card and open **View work log**. **Last saved** refers to the checkpoint; **Review interrupted work** indicates a failed or uncertain action with possible effects.
3. Ask the assistant to read the work log, inspect the relevant files or command/browser effects, and continue from the saved checkpoint. Review later actions because the checkpoint may be older than the log.
4. After inspection, the assistant explicitly acknowledges affected event IDs with a review note and saves an updated checkpoint. Further changes wait for this review where side effects may remain. The assistant also repeats its skill catalog check after a service restart.

| Outcome | What it means |
| --- | --- |
| Started | The action began; a final outcome has not been saved. |
| Execution recorded | Local execution was recorded; ChatGPT receipt is unconfirmed. |
| Execution error | The action reported failure; partial effects may remain. |
| Outcome unknown | The action may have completed or partly taken effect before interruption or a failed history save. Inspect before repeating it. |

Reviewing an event records that it was inspected. It preserves the original outcome and does not undo its effects or prove success. For interrupted shell work, check whether the command and its descendants have stopped before deciding to retry.

An interrupted direct text save may leave a temporary staging file. When present, the log's **Staging path** and **Save phase** identify the recorded file relative to that folder revision. Inspect that exact path and the destination before deciding whether cleanup or retry is appropriate. Chat2Local does not automatically scan for or delete orphaned staging files, or replay the interrupted save.

## Continue in a new chat

In the old chat's work log, click **Copy recovery summary** and paste it into a new conversation yourself. Then register the new chat and choose its folder manually in Chat2Local. The summary labels archived folder revisions and includes the loaded history; use **Load older actions** before copying when needed. Copied context does not transfer folder access or give the new model access to another chat's private log.

## Manage history

Detailed history loads only when opened or requested. Choose a folder revision in the history picker to view archived context. The native owner can view historical revisions; model tools use only the current chat's selected revision.

**Clear completed history** asks for confirmation and removes completed or explicitly reviewed events. It keeps pending actions, unreviewed failed/uncertain actions, and the latest checkpoint. Eligible history is retained for up to 30 days and 10,000 events per chat/folder revision, subject to global budgets of 50,000 accounted records and 32 MiB of accounted recovery payload. These budgets do not cap the SQLite file or total runtime state at 32 MiB. A store full of protected records can block further changes instead of deleting evidence.

## Limits and privacy

Automatic history stores safe execution facts rather than raw commands, URLs, file/page content, screenshots, or stdout/stderr. Checkpoints and review notes are concise prose supplied by the model. Common secret patterns are redacted in stored prose and copied summaries, including chat titles and folder paths at the copy boundary, but redaction cannot guarantee that arbitrary text is safe to share. Review copied text before sharing it.

Direct text writes and edits use atomic replacement to resist interrupted saves. This does not make shell writes or generated artifacts atomic, back up the whole project, keep earlier file versions, or roll back arbitrary effects. Work outside Chat2Local is not recorded. Checkpoints cannot restore unsent chat text, guarantee ChatGPT received results, or prove the model followed instructions.

Recovery keeps the user in control: it does not replay actions, open or wake conversations, send messages, create workers, or bind chats. The app offers explicit service restart and deliberate copying. See [troubleshooting](../TROUBLESHOOTING.md) and [security and privacy](../SECURITY.md).
