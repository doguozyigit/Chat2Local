# A short Chat2Local demo

This walkthrough demonstrates manual folder selection, a project skill, and a verified local write. It takes about a minute once the [ChatGPT connection](INSTALL.md) is ready; response time varies.

## Try it

1. Copy `examples/hello-local-dev` somewhere convenient, including its hidden `.agents` directory. Use the copy so the original stays clean.
2. Start a new ChatGPT chat with Chat2Local selected. Send:

   > Use Chat2Local to build the small task list described in my local folder. Make it easy to use on my phone and laptop.

3. Match the returned setup code in Chat2Local. Choose the copied demo folder, then reply **connected**.
4. The chat should read `briefing.md`, list skills, read the project's `local-demo` guide and work history, save a checkpoint, and create and read back `index.html`.
5. Open `index.html` from Finder. Add a task, complete it, refresh, and confirm it is still saved.

## What to show in a recording

| Moment | Evidence |
| --- | --- |
| The chat asks for its folder | Setup code; no copied conversation link. |
| You choose the demo folder | The matching Chat2Local row displays that folder. |
| ChatGPT works locally | Skill and file tool calls, followed by a successful write/read. |
| You open the result | A real file in Finder and the task list in a browser. |

A downloadable attachment alone does not verify a local write. Check the file in the selected folder. The automated installation check verifies the service and bridge with synthetic chats; this walkthrough verifies your own ChatGPT client's integration.

For a second-chat demonstration, connect another chat to the same folder and ask it to review `index.html`. It gets its own folder selection and skill check while reading the same files.

## Try a follow-up

In the first chat, ask:

> Add a button to clear completed tasks. Keep the tasks I already saved and check that the controls work with a keyboard.

Check the file in Finder again, then open **View work log** in Chat2Local. It should show the updated checkpoint and recorded local actions. If a run is interrupted, ask the chat to read its saved history and inspect the existing file before continuing. This is a manual recovery workflow; the app does not start another chat turn automatically.
