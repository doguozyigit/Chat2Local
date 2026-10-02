# Chat2Local troubleshooting

## Chat2Local is offline

Open the Mac app and refresh its status. If its bundled service stopped unexpectedly, choose **Restart Chat2Local service**. The app checks for a healthy service before launching and avoids duplicating an owned running process. Recovery does not use an automatic service restart loop. A successful service restart restores saved records; it does not repeat tools or restart the chat.

If the service is ready but ChatGPT cannot reach it, check the **ChatGPT connection** card and connection settings. Refresh the Chat2Local actions in ChatGPT after updating the plugin or service. Keep tunnel runtime keys and the API token private; do not paste them into a chat or bug report.

## A chat has no folder

Have the chat call `local_dev_project_setup`, match its returned code in Chat2Local, and choose a folder. A new chat needs its own manual selection even when an older chat used that folder. Verify the folder exists and is accessible. See [folder setup](docs/PROJECT_SETUP.md).

## A change requires skills or a checkpoint

After a service restart or folder change, the assistant must list skills, read relevant guidance and the work log, then save a checkpoint before making changes. If the previous checkpoint is `completed`, further work needs a new checkpoint. Reading an old checkpoint alone does not open the change gate.

## Review interrupted work

Choose **View work log** in the chat card. Distinguish recorded execution, execution errors, and unknown outcomes. The saved checkpoint may predate later actions. Ask the assistant to read history and inspect the actual files or command/browser effects, then acknowledge the inspected event IDs with a review note in a checkpoint. Load older history if the relevant event is on an earlier page. Do not rerun a command or write solely because ChatGPT did not receive its response.

For an interrupted command, check whether the command and its descendants have stopped and what effects remain before retrying. Atomic direct text saves do not make shell commands or external actions atomic. See [work recovery](docs/WORK_RECOVERY.md).

## Recovery storage is unavailable or full

Free disk space if needed. Review failed or uncertain actions, and use **Clear completed history** to remove eligible records. Clearing preserves pending actions, unreviewed failed or uncertain records, and the checkpoint. Protected evidence can fill the storage budget and block further changes. Do not delete the database to bypass the warning: it also contains folder connections and recovery evidence. If the problem persists, keep the state private and report the version, affected action, and a redacted error.
