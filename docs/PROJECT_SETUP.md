# Choose a local folder for a chat

Start Chat2Local and enable its plugin in ChatGPT. The chat must call `local_dev_project_setup` once before Chat2Local can show it. A short descriptive title is optional; the returned setup code identifies the row to select.

Open Chat2Local, find that setup code, and choose an existing folder or create one in the native folder chooser. Return to ChatGPT and reply **connected**. The assistant checks its current connection, lists relevant skills, reads the work log, and saves a concise checkpoint before making changes.

The model cannot select a folder through a tool, and the setup action does not grant access. No chat URL or exact title needs to be copied. If ChatGPT does not supply a stable chat identity, setup explains that limitation instead of guessing which chat owns the request.

## Several chats in one folder

Connect each chat separately. They may all choose the same folder. Each chat has an independent connection, skill check, checkpoint, and recovery history, while the folder's files are shared. Changing or disconnecting one chat does not affect another chat's connection or share its private history.

## Change a folder

Select the chat in Chat2Local and choose another folder or disconnect it. An active project tool must finish before the folder can change. A stale selection is refused so the UI can refresh the current connection. Files in the previous folder stay in place. The folder revision changes; the assistant needs a fresh skill catalog check and checkpoint before further changes. These checks also repeat after Chat2Local restarts.

The Mac app's **View work log** can show archived folder revisions. This is owner access to historical context and does not reconnect the chat to an old folder. Model tools use only the chat's current selected folder and revision.

## Resume saved work

After an interruption, return to the same chat and ask it to read its Chat2Local work log before continuing. The assistant should compare the saved checkpoint with the actual files and inspect failed or uncertain actions before repeating them. A saved checkpoint may be older than later recorded actions.

To continue in a new chat, click **Copy recovery summary** in the old chat's work log and paste it into the new conversation yourself. The new chat must register and have a folder selected manually. Copied context does not transfer folder access or private recovery history. See [work recovery](WORK_RECOVERY.md).

## Continue without a local folder

The user may continue working in ChatGPT without choosing a folder. Chat2Local project tools remain unavailable for that chat until a folder is selected. Downloadable ChatGPT output is not evidence that a file was saved on the Mac.

## Connection troubleshooting

- Keep Chat2Local running and check its **ChatGPT connection** card.
- Refresh Chat2Local actions after updating the plugin or service.
- Match the setup code rather than a possibly duplicated chat title.
- Verify the selected folder exists and is accessible to your macOS account.
- Keep the API token private. Do not paste it into ChatGPT.
