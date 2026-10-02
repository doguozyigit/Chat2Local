import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatFolderConnection } from "@local-dev/protocol";
import { resolveProjectFolder } from "./project-folder.js";
import { WorkLogStore, type WorkLogStoreOptions } from "./work-log-store.js";

export interface ChatFolderScope {
  chatId: string;
  hostThreadId: string;
  projectPath: string;
  revision: number;
}

export type ChatFolderErrorCode = "missing_chat_identity" | "unknown_chat" | "revision_conflict"
  | "chat_busy" | "folder_required" | "invalid_project_folder" | "store_closed";

export class ChatFolderError extends Error {
  constructor(readonly code: ChatFolderErrorCode, message: string) {
    super(message);
    this.name = "ChatFolderError";
  }
}

interface ConnectionRow {
  id: string;
  host_thread_id: string;
  title: string | null;
  setup_code: string;
  folder_path: string | null;
  revision: number;
  created_at: string;
  last_seen_at: string;
}

/** Folder grants are created only by the authenticated native folder picker. */
export class ChatFolderStore {
  private readonly db: DatabaseSync;
  readonly workLog: WorkLogStore;
  private readonly activeScopes = new Map<string, number>();
  private closed = false;

  constructor(readonly databasePath: string, options: { bootId?: string; workLog?: WorkLogStoreOptions } = {}) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
      const fd = openSync(databasePath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) {
          throw new Error("Chat folders require an owned regular database file.");
        }
        fchmodSync(fd, 0o600);
      } finally {
        closeSync(fd);
      }
    }
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec(`
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS chat_folders (
          id TEXT PRIMARY KEY,
          host_thread_id TEXT NOT NULL UNIQUE,
          title TEXT,
          setup_code TEXT NOT NULL,
          folder_path TEXT,
          revision INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        );
      `);
      this.workLog = new WorkLogStore(this.db, options.bootId ?? randomUUID(), options.workLog);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  observe(hostThreadId: string, title?: string | null): ChatFolderConnection {
    this.assertOpen();
    const host = requireHostIdentity(hostThreadId);
    const existing = this.rowByHost(host);
    const now = new Date().toISOString();
    const observedTitle = title === undefined ? existing?.title ?? null : title?.trim().slice(0, 240) || null;
    if (existing) {
      this.db.prepare("UPDATE chat_folders SET title=?, last_seen_at=? WHERE id=?")
        .run(observedTitle, now, existing.id);
      return this.get(existing.id)!;
    }
    const id = randomUUID();
    const setupCode = `LD-${createHash("sha256").update(host).digest("hex").slice(0, 8).toUpperCase()}`;
    this.db.prepare(`INSERT INTO chat_folders
      (id, host_thread_id, title, setup_code, folder_path, revision, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, NULL, 0, ?, ?)`).run(id, host, observedTitle, setupCode, now, now);
    return this.get(id)!;
  }

  getByHost(hostThreadId: string): ChatFolderConnection | null {
    this.assertOpen();
    const row = this.rowByHost(requireHostIdentity(hostThreadId));
    return row ? connection(row) : null;
  }

  get(id: string): ChatFolderConnection | null {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM chat_folders WHERE id=?").get(id) as unknown as ConnectionRow | undefined;
    return row ? connection(row) : null;
  }

  list(): ChatFolderConnection[] {
    this.assertOpen();
    return (this.db.prepare("SELECT * FROM chat_folders ORDER BY last_seen_at DESC, id ASC").all() as unknown as ConnectionRow[])
      .map(connection);
  }

  async connect(id: string, folderPath: string, expectedRevision: number): Promise<ChatFolderConnection> {
    this.assertMutable(id, expectedRevision);
    const folder = await resolveProjectFolder(folderPath);
    if (!folder.ok) throw new ChatFolderError("invalid_project_folder", folder.nextAction);
    // Folder validation yields to other requests. Check the grant again before changing it.
    const current = this.assertMutable(id, expectedRevision);
    if (current.folderPath === folder.projectPath) return current;
    this.db.prepare("UPDATE chat_folders SET folder_path=?, revision=revision+1 WHERE id=?")
      .run(folder.projectPath, id);
    return this.get(id)!;
  }

  disconnect(id: string, expectedRevision: number): ChatFolderConnection {
    const current = this.assertMutable(id, expectedRevision);
    if (current.folderPath === null) return current;
    this.db.prepare("UPDATE chat_folders SET folder_path=NULL, revision=revision+1 WHERE id=?").run(id);
    return this.get(id)!;
  }

  async useScope<T>(hostThreadId: string, callback: (scope: ChatFolderScope) => T | Promise<T>): Promise<T> {
    const host = requireHostIdentity(hostThreadId);
    const chat = this.getByHost(host);
    if (!chat) throw new ChatFolderError("unknown_chat", "Open Chat2Local and select a folder for this chat.");
    if (!chat.folderPath) throw new ChatFolderError("folder_required", "Open Chat2Local and select a folder for this chat.");
    this.activeScopes.set(chat.id, (this.activeScopes.get(chat.id) ?? 0) + 1);
    try {
      const folder = await resolveProjectFolder(chat.folderPath);
      this.assertOpen();
      if (!folder.ok || folder.projectPath !== chat.folderPath) {
        throw new ChatFolderError("invalid_project_folder", "This chat's folder is unavailable. Open Chat2Local and select a usable folder.");
      }
      return await callback({ chatId: chat.id, hostThreadId: host, projectPath: folder.projectPath, revision: chat.revision });
    } finally {
      const remaining = (this.activeScopes.get(chat.id) ?? 1) - 1;
      if (remaining === 0) this.activeScopes.delete(chat.id);
      else this.activeScopes.set(chat.id, remaining);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.workLog.closeRun(); } finally { this.db.close(); }
  }

  private rowByHost(host: string): ConnectionRow | null {
    return this.db.prepare("SELECT * FROM chat_folders WHERE host_thread_id=?").get(host) as unknown as ConnectionRow | undefined ?? null;
  }

  private assertMutable(id: string, expectedRevision: number): ChatFolderConnection {
    const chat = this.get(id);
    if (!chat) throw new ChatFolderError("unknown_chat", "This chat is no longer available. Refresh Chat2Local.");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== chat.revision) {
      throw new ChatFolderError("revision_conflict", "This chat's folder changed. Refresh Chat2Local and try again.");
    }
    if (this.activeScopes.has(id)) throw new ChatFolderError("chat_busy", "This chat is using its folder. Try again after its current tool finishes.");
    return chat;
  }

  private assertOpen(): void {
    if (this.closed) throw new ChatFolderError("store_closed", "Chat folder storage is closed.");
  }
}

function requireHostIdentity(host: string): string {
  if (typeof host !== "string" || !host.trim() || host.length > 500) {
    throw new ChatFolderError("missing_chat_identity", "This host did not provide a stable chat identity.");
  }
  return host.trim();
}

function connection(row: ConnectionRow): ChatFolderConnection {
  return {
    id: row.id, title: row.title, setupCode: row.setup_code, folderPath: row.folder_path,
    revision: row.revision, createdAt: row.created_at, lastSeenAt: row.last_seen_at,
  };
}
