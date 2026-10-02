import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { ChatFolderStore } from "./chat-folder-store.js";

for (const pauseAt of ["beforeCommit", "committed"] as const) {
  test(`killed staged save at ${pauseAt} retains exact stage evidence and never claims completion`, async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "local-dev-stage-journal-")));
    const folder = join(base, "project"); await mkdir(folder); await writeFile(join(folder, "canary.txt"), "complete old file");
    const database = join(base, "chats.sqlite");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { ChatFolderStore } from ${JSON.stringify(new URL("./chat-folder-store.ts", import.meta.url).href)};
      import { createScopedFileWriter } from ${JSON.stringify(new URL("./local-tools.ts", import.meta.url).href)};
      import { relative } from 'node:path';
      const chats = new ChatFolderStore(${JSON.stringify(database)});
      const first = chats.observe('stage-host');
      const chat = await chats.connect(first.id, ${JSON.stringify(folder)}, first.revision);
      const scope = { chatId:chat.id, revision:chat.revision, projectPath:chat.folderPath };
      const operation = chats.workLog.start(scope, 'local_dev_file_write', {path:'canary.txt'}, true);
      const writer = createScopedFileWriter({onPhase:async info => {
        if(['stageCreated','beforeCommit','committed'].includes(info.phase)) chats.workLog.annotate(operation, {stagePath:relative(chat.folderPath,info.stagingPath),stagePhase:info.phase,stageDevice:info.stagingDevice,stageInode:info.stagingInode});
        if(info.phase===${JSON.stringify(pauseAt)}) { process.stdout.write('ready\\n'); await new Promise(()=>{}); }
      }});
      await writer.writeScopedFile(chat.folderPath,'canary.txt','complete new file');
    `], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    try {
      await new Promise<void>((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error("Child did not reach the journaled stage")), 5000);
        child.stdout.on("data", bytes => { if (bytes.toString().includes("ready")) { clearTimeout(timer); resolveReady(); } });
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("Child exited before pause")); });
      });
      child.kill("SIGKILL"); await exited;
      const chats = new ChatFolderStore(database);
      try {
        const chat = chats.getByHost("stage-host")!;
        const event = chats.workLog.read({ chatId: chat.id, revision: chat.revision }).events[0]!;
        assert.equal(event.status, "outcome_unknown"); assert.equal(event.metadata.stagePhase, pauseAt);
        assert.equal(chats.workLog.summary({ chatId: chat.id, revision: chat.revision }).reviewRequired, true);
        const destination = join(folder, "canary.txt");
        const candidate = pauseAt === "committed" ? destination : join(folder, String(event.metadata.stagePath));
        const evidence = await stat(candidate, { bigint: true });
        assert.equal(String(evidence.dev), event.metadata.stageDevice); assert.equal(String(evidence.ino), event.metadata.stageInode);
        assert.equal(await readFile(candidate, "utf8"), "complete new file");
        assert.equal(await readFile(destination, "utf8"), pauseAt === "committed" ? "complete new file" : "complete old file");
      } finally { chats.close(); }
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      await rm(base, { recursive: true, force: true });
    }
  });
}
