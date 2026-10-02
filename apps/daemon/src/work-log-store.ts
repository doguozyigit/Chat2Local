import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WorkCheckpoint, WorkCheckpointInput, WorkLogEvent, WorkLogMetadata, WorkLogPage, WorkLogRevision, WorkRecoverySummary } from "@local-dev/protocol";
import { redactWorkText } from "./work-log-redaction.js";

export { redactWorkText } from "./work-log-redaction.js";

export interface WorkLogScope { chatId: string; revision: number; projectPath?: string; hostThreadId?: string }
export interface WorkLogReadOptions { limit?: number; beforeSequence?: number }
export interface WorkLogStoreOptions {
  now?: () => Date;
  maxRows?: number;
  maxBytes?: number;
  maxEventsPerScope?: number;
  retentionDays?: number;
  beforeWrite?: (phase: "start" | "stage" | "finish" | "checkpoint" | "review" | "clear" | "close") => void;
}
export type WorkLogErrorCode = "invalid_input" | "storage_full" | "operation_not_found" | "operation_finished" | "store_closed";
export class WorkLogError extends Error {
  constructor(readonly code: WorkLogErrorCode, message: string) { super(message); this.name = "WorkLogError"; }
}

interface ScopeRow { chat_id: string; revision: number; folder_path: string | null; last_sequence: number; bytes: number }
interface EventRow {
  id: string; chat_id: string; revision: number; sequence: number; boot_id: string; tool: string;
  started_at: string; ended_at: string | null; status: WorkLogEvent["status"]; may_side_effect: number;
  metadata: string; result: string | null; reviewed_at: string | null; review_note: string | null; bytes: number;
}
interface CheckpointRow { payload: string; saved_at: string; sequence: number; bytes: number }
const MAX_METADATA_BYTES = 4096;
const MAX_CHECKPOINT_BYTES = 8192;

/** Uses its owner's FULL-synchronous connection; transactions never span tool execution. */
export class WorkLogStore {
  private closed = false;
  private readonly uncertainOperations = new Set<string>();
  private readonly options: Required<Pick<WorkLogStoreOptions, "maxRows" | "maxBytes" | "maxEventsPerScope" | "retentionDays">> & WorkLogStoreOptions;

  constructor(private readonly db: DatabaseSync, readonly bootId: string, options: WorkLogStoreOptions = {}) {
    requireText(bootId, 200, "Daemon run identity");
    this.options = { maxRows: 50_000, maxBytes: 32 * 1024 * 1024, maxEventsPerScope: 10_000, retentionDays: 30, ...options };
    for (const [key, value] of Object.entries(this.options)) {
      if (["maxRows", "maxBytes", "maxEventsPerScope", "retentionDays"].includes(key) && (!Number.isSafeInteger(value) || (value as number) < 1)) invalid("Recovery storage limits must be positive integers.");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_log_runs (boot_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS work_log_scopes (chat_id TEXT NOT NULL, revision INTEGER NOT NULL, folder_path TEXT, last_sequence INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL, PRIMARY KEY(chat_id,revision));
      CREATE TABLE IF NOT EXISTS work_log_events (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, revision INTEGER NOT NULL, sequence INTEGER NOT NULL,
        boot_id TEXT NOT NULL, tool TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('started','execution_recorded','execution_error','outcome_unknown')),
        may_side_effect INTEGER NOT NULL, metadata TEXT NOT NULL, result TEXT, reviewed_at TEXT, review_note TEXT, bytes INTEGER NOT NULL,
        UNIQUE(chat_id,revision,sequence)
      );
      CREATE INDEX IF NOT EXISTS work_log_events_scope ON work_log_events(chat_id,revision,sequence DESC);
      CREATE INDEX IF NOT EXISTS work_log_events_boot ON work_log_events(boot_id,status);
      CREATE TABLE IF NOT EXISTS work_log_checkpoints (chat_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, saved_at TEXT NOT NULL, sequence INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(chat_id,revision));
    `);
    this.transaction(() => {
      const now = this.now();
      this.db.prepare("UPDATE work_log_events SET status='outcome_unknown', ended_at=? WHERE status='started' AND boot_id<>?").run(now, bootId);
      this.db.prepare("UPDATE work_log_runs SET ended_at=COALESCE(ended_at,?) WHERE boot_id<>?").run(now, bootId);
      if (!this.db.prepare("SELECT boot_id FROM work_log_runs WHERE boot_id=?").get(bootId)) {
        const bytes = size(bootId) + 128;
        this.makeSpace(1, bytes);
        this.db.prepare("INSERT INTO work_log_runs (boot_id,started_at,bytes) VALUES (?,?,?)").run(bootId, now, bytes);
      }
    });
  }

  start(scope: WorkLogScope, tool: string, metadata: WorkLogMetadata, mayHaveSideEffects: boolean): string {
    this.assertOpen(); validateScope(scope);
    if (typeof tool !== "string" || !/^[a-z][a-z0-9_]{0,99}$/.test(tool)) invalid("Recovery tool name is invalid.");
    if (typeof mayHaveSideEffects !== "boolean") invalid("Recovery operation classification is invalid.");
    const safeMetadata = safeRecord(metadata);
    const id = randomUUID();
    const now = this.now();
    const bytes = size(safeMetadata) + size(tool) + size(scope.chatId) + size(this.bootId) + 256;
    this.options.beforeWrite?.("start");
    this.transaction(() => {
      this.ensureScope(scope);
      this.makeSpace(1, bytes);
      const sequence = this.nextSequence(scope);
      this.db.prepare(`INSERT INTO work_log_events (id,chat_id,revision,sequence,boot_id,tool,started_at,status,may_side_effect,metadata,bytes)
        VALUES (?,?,?,?,?,?,?,'started',?,?,?)`).run(id, scope.chatId, scope.revision, sequence, this.bootId, tool, now, mayHaveSideEffects ? 1 : 0, safeMetadata, bytes);
    });
    return id;
  }

  finish(id: string, status: "execution_recorded" | "execution_error", result: WorkLogMetadata): void {
    this.assertOpen(); requireText(id, 100, "Operation identity");
    if (status !== "execution_recorded" && status !== "execution_error") invalid("Recovery outcome is invalid.");
    const safeResult = safeRecord(result);
    this.options.beforeWrite?.("finish");
    this.transaction(() => {
      const row = this.event(id);
      if (row.status !== "started" || row.boot_id !== this.bootId) throw new WorkLogError("operation_finished", "This operation already has a recorded or uncertain outcome.");
      this.makeSpace(0, size(safeResult));
      this.db.prepare("UPDATE work_log_events SET status=?,result=?,ended_at=?,bytes=bytes+? WHERE id=?")
        .run(status, safeResult, this.now(), size(safeResult), id);
      this.pruneRetention();
    });
  }

  /** Durable, bounded evidence for an owned staging file; never stores file contents. */
  annotate(id: string, facts: WorkLogMetadata): void {
    this.assertOpen(); requireText(id, 100, "Operation identity");
    this.options.beforeWrite?.("stage");
    this.transaction(() => {
      const row = this.event(id);
      if (row.status !== "started" || row.boot_id !== this.bootId) throw new WorkLogError("operation_finished", "This operation is no longer active in this run.");
      const metadata = safeRecord({ ...JSON.parse(row.metadata) as WorkLogMetadata, ...facts });
      const delta = size(metadata) - size(row.metadata);
      this.makeSpace(0, delta);
      this.db.prepare("UPDATE work_log_events SET metadata=?,bytes=bytes+? WHERE id=?").run(metadata, delta, id);
    });
  }

  /** A completed callback whose finish record failed must remain visibly uncertain. */
  markOutcomeUnknown(id: string): void {
    this.assertOpen(); requireText(id, 100, "Operation identity");
    const row = this.event(id);
    if (row.status === "outcome_unknown") return;
    if (row.status !== "started" || row.boot_id !== this.bootId) throw new WorkLogError("operation_finished", "This operation already has a recorded outcome.");
    this.uncertainOperations.add(id);
    this.options.beforeWrite?.("finish");
    this.transaction(() => {
      this.db.prepare("UPDATE work_log_events SET status='outcome_unknown',ended_at=? WHERE id=? AND status='started'").run(this.now(), id);
    });
    this.uncertainOperations.delete(id);
  }

  read(scope: WorkLogScope, options: WorkLogReadOptions = {}): WorkLogPage {
    this.assertOpen(); validateScope(scope);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) invalid("Recovery page size must be between 1 and 200.");
    if (options.beforeSequence !== undefined && (!Number.isSafeInteger(options.beforeSequence) || options.beforeSequence < 1)) invalid("Recovery page cursor is invalid.");
    const rows = this.db.prepare("SELECT * FROM work_log_events WHERE chat_id=? AND revision=? AND sequence<? ORDER BY sequence DESC LIMIT ?")
      .all(scope.chatId, scope.revision, options.beforeSequence ?? Number.MAX_SAFE_INTEGER, limit + 1) as unknown as EventRow[];
    const events = rows.slice(0, limit).map((row) => event(this.uncertainOperations.has(row.id) ? { ...row, status: "outcome_unknown" } : row));
    return {
      revision: scope.revision, folderPath: this.scopeRow(scope)?.folder_path ?? null,
      checkpoint: this.savedCheckpoint(scope), summary: this.summary(scope), events,
      nextBeforeSequence: rows.length > limit ? events.at(-1)!.sequence : null,
    };
  }

  summary(scope: WorkLogScope): WorkRecoverySummary {
    this.assertOpen(); validateScope(scope);
    const checkpoint = this.savedCheckpoint(scope);
    const counts = this.db.prepare(`SELECT
      SUM(CASE WHEN status='started' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status IN ('outcome_unknown','execution_error') AND reviewed_at IS NULL THEN 1 ELSE 0 END) AS unresolved,
      SUM(CASE WHEN status IN ('outcome_unknown','execution_error') AND reviewed_at IS NULL AND may_side_effect=1 THEN 1 ELSE 0 END) AS review
      FROM work_log_events WHERE chat_id=? AND revision=?`).get(scope.chatId, scope.revision) as { active: number | null; unresolved: number | null; review: number | null };
    const locallyUncertain = (this.db.prepare("SELECT id,may_side_effect FROM work_log_events WHERE chat_id=? AND revision=? AND status='started'")
      .all(scope.chatId, scope.revision) as unknown as { id: string; may_side_effect: number }[]).filter((row) => this.uncertainOperations.has(row.id));
    return {
      lastSavedAt: checkpoint?.savedAt ?? null, checkpointStatus: checkpoint?.status ?? null,
      activeOperations: (counts.active ?? 0) - locallyUncertain.length, unresolvedOperations: (counts.unresolved ?? 0) + locallyUncertain.length,
      reviewRequired: (counts.review ?? 0) > 0 || locallyUncertain.some((row) => row.may_side_effect === 1), latestSequence: this.scopeRow(scope)?.last_sequence ?? 0,
    };
  }

  checkpoint(scope: WorkLogScope, input: WorkCheckpointInput): WorkCheckpoint {
    this.assertOpen(); validateScope(scope);
    const payload = safeCheckpoint(input);
    const savedAt = this.now();
    this.options.beforeWrite?.("checkpoint");
    return this.transaction(() => {
      this.ensureScope(scope);
      const previous = this.checkpointRow(scope);
      const bytes = size(payload) + size(scope.chatId) + 128;
      this.makeSpace(previous ? 0 : 1, bytes - (previous?.bytes ?? 0));
      const sequence = this.nextSequence(scope);
      this.db.prepare(`INSERT INTO work_log_checkpoints (chat_id,revision,payload,saved_at,sequence,bytes) VALUES (?,?,?,?,?,?)
        ON CONFLICT(chat_id,revision) DO UPDATE SET payload=excluded.payload,saved_at=excluded.saved_at,sequence=excluded.sequence,bytes=excluded.bytes`)
        .run(scope.chatId, scope.revision, payload, savedAt, sequence, bytes);
      return { ...JSON.parse(payload) as WorkCheckpointInput, savedAt, sequence };
    });
  }

  review(scope: WorkLogScope, ids: string[], note: string): void {
    this.assertOpen(); validateScope(scope);
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length) invalid("Select between 1 and 100 distinct operations to review.");
    requireText(note, 2000, "Review note");
    const safeNote = redactWorkText(note.trim());
    this.options.beforeWrite?.("review");
    this.transaction(() => {
      const rows = ids.map((id) => {
        requireText(id, 100, "Operation identity");
        const row = this.event(id);
        if (row.chat_id !== scope.chatId || row.revision !== scope.revision) throw new WorkLogError("operation_not_found", "This operation is not in the selected chat folder revision.");
        if (row.status !== "execution_error" && row.status !== "outcome_unknown" && !this.uncertainOperations.has(id)) invalid("Only settled uncertain or failed operations can be reviewed.");
        return row;
      });
      const reviewedAt = this.now();
      for (const row of rows) {
        this.db.prepare(`UPDATE work_log_events SET reviewed_at=?,review_note=?,bytes=bytes+?,
          status=CASE WHEN status='started' THEN 'outcome_unknown' ELSE status END,
          ended_at=COALESCE(ended_at,?) WHERE id=?`)
          .run(reviewedAt, safeNote, size(safeNote) - size(row.review_note ?? ""), reviewedAt, row.id);
      }
      // Explicitly reviewed records are now eligible for safe compaction, even at a full budget.
      this.makeSpace(0, 0);
    });
    ids.forEach((id) => this.uncertainOperations.delete(id));
  }

  clearCompleted(scope: WorkLogScope): number {
    this.assertOpen(); validateScope(scope);
    this.options.beforeWrite?.("clear");
    return this.transaction(() => Number(this.db.prepare(`DELETE FROM work_log_events WHERE chat_id=? AND revision=? AND
      (status='execution_recorded' OR (status IN ('execution_error','outcome_unknown') AND reviewed_at IS NOT NULL))`)
      .run(scope.chatId, scope.revision).changes));
  }

  revisions(chatId: string): WorkLogRevision[] {
    this.assertOpen(); requireText(chatId, 200, "Chat identity");
    return (this.db.prepare(`SELECT s.revision,s.folder_path,c.saved_at FROM work_log_scopes s
      LEFT JOIN work_log_checkpoints c ON s.chat_id=c.chat_id AND s.revision=c.revision WHERE s.chat_id=? ORDER BY s.revision DESC`)
      .all(chatId) as unknown as { revision: number; folder_path: string | null; saved_at: string | null }[])
      .map((row) => ({ revision: row.revision, folderPath: row.folder_path, lastSavedAt: row.saved_at }));
  }

  closeRun(): void {
    if (this.closed) return;
    this.options.beforeWrite?.("close");
    this.transaction(() => {
      const now = this.now();
      this.db.prepare("UPDATE work_log_events SET status='outcome_unknown',ended_at=? WHERE boot_id=? AND status='started'").run(now, this.bootId);
      this.db.prepare("UPDATE work_log_runs SET ended_at=? WHERE boot_id=?").run(now, this.bootId);
    });
    this.closed = true;
  }

  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private assertOpen(): void { if (this.closed) throw new WorkLogError("store_closed", "Recovery storage is closed."); }
  private transaction<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = callback(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private event(id: string): EventRow {
    const row = this.db.prepare("SELECT * FROM work_log_events WHERE id=?").get(id) as unknown as EventRow | undefined;
    if (!row) throw new WorkLogError("operation_not_found", "This recovery operation is unavailable.");
    return row;
  }
  private scopeRow(scope: WorkLogScope): ScopeRow | undefined { return this.db.prepare("SELECT * FROM work_log_scopes WHERE chat_id=? AND revision=?").get(scope.chatId, scope.revision) as unknown as ScopeRow | undefined; }
  private checkpointRow(scope: WorkLogScope): CheckpointRow | undefined { return this.db.prepare("SELECT * FROM work_log_checkpoints WHERE chat_id=? AND revision=?").get(scope.chatId, scope.revision) as unknown as CheckpointRow | undefined; }
  private savedCheckpoint(scope: WorkLogScope): WorkCheckpoint | null {
    const row = this.checkpointRow(scope);
    return row ? { ...JSON.parse(row.payload) as WorkCheckpointInput, savedAt: row.saved_at, sequence: row.sequence } : null;
  }
  private ensureScope(scope: WorkLogScope): void {
    const previous = this.scopeRow(scope);
    if (previous) {
      if (scope.projectPath !== undefined && previous.folder_path !== scope.projectPath) invalid("Recovery folder identity cannot change within a revision.");
      return;
    }
    const folder = scope.projectPath ?? null;
    const bytes = size(scope.chatId) + size(folder ?? "") + 128;
    this.makeSpace(1, bytes);
    this.db.prepare("INSERT INTO work_log_scopes (chat_id,revision,folder_path,bytes) VALUES (?,?,?,?)").run(scope.chatId, scope.revision, folder, bytes);
  }
  private nextSequence(scope: WorkLogScope): number {
    const row = this.db.prepare("UPDATE work_log_scopes SET last_sequence=last_sequence+1 WHERE chat_id=? AND revision=? RETURNING last_sequence")
      .get(scope.chatId, scope.revision) as { last_sequence: number };
    return row.last_sequence;
  }
  private pruneRetention(): void {
    const cutoff = new Date(new Date(this.now()).getTime() - this.options.retentionDays * 86_400_000).toISOString();
    this.db.prepare(`DELETE FROM work_log_events WHERE (status='execution_recorded' OR (reviewed_at IS NOT NULL AND status IN ('execution_error','outcome_unknown'))) AND ended_at<?`).run(cutoff);
    this.db.prepare(`DELETE FROM work_log_events WHERE id IN (
      SELECT id FROM (SELECT id,ROW_NUMBER() OVER (PARTITION BY chat_id,revision ORDER BY sequence DESC) AS position
      FROM work_log_events WHERE status='execution_recorded' OR (reviewed_at IS NOT NULL AND status IN ('execution_error','outcome_unknown')))
      WHERE position>?)`).run(this.options.maxEventsPerScope);
  }
  private makeSpace(extraRows: number, extraBytes: number, excluded = new Set<string>()): void {
    this.pruneRetention();
    const usage = this.db.prepare(`SELECT SUM(rows) AS rows,SUM(bytes) AS bytes FROM (
      SELECT COUNT(*) AS rows,COALESCE(SUM(bytes),0) AS bytes FROM work_log_events UNION ALL
      SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM work_log_checkpoints UNION ALL
      SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM work_log_scopes UNION ALL
      SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM work_log_runs)`).get() as { rows: number; bytes: number };
    const fits = () => usage.rows + extraRows <= this.options.maxRows && usage.bytes + extraBytes <= this.options.maxBytes;
    if (fits()) return;
    const candidates = this.db.prepare(`SELECT id,bytes FROM work_log_events WHERE status='execution_recorded' OR
      (status IN ('execution_error','outcome_unknown') AND reviewed_at IS NOT NULL) ORDER BY ended_at,sequence`).all() as unknown as { id: string; bytes: number }[];
    for (const row of candidates) {
      if (excluded.has(row.id)) continue;
      this.db.prepare("DELETE FROM work_log_events WHERE id=?").run(row.id);
      usage.rows--; usage.bytes -= row.bytes;
      if (fits()) return;
    }
    // Ended run markers carry no operation evidence and may be compacted.
    const runs = this.db.prepare("SELECT boot_id,bytes FROM work_log_runs WHERE boot_id<>? AND ended_at IS NOT NULL ORDER BY ended_at").all(this.bootId) as unknown as { boot_id: string; bytes: number }[];
    for (const row of runs) {
      this.db.prepare("DELETE FROM work_log_runs WHERE boot_id=?").run(row.boot_id);
      usage.rows--; usage.bytes -= row.bytes;
      if (fits()) return;
    }
    throw new WorkLogError("storage_full", "Recovery storage is full of protected records. Review interrupted work or clear completed history before making more changes.");
  }
}

function validateScope(scope: WorkLogScope): void {
  if (!scope || typeof scope !== "object") invalid("Recovery scope is invalid.");
  requireText(scope.chatId, 200, "Chat identity");
  if (!Number.isSafeInteger(scope.revision) || scope.revision < 0) invalid("Recovery folder revision is invalid.");
  if (scope.projectPath !== undefined) requireText(scope.projectPath, 4096, "Recovery folder path");
}
function requireText(value: unknown, limit: number, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) invalid(`${field} is invalid or too long.`);
}
function invalid(message: string): never { throw new WorkLogError("invalid_input", message); }
function size(value: string): number { return Buffer.byteLength(value, "utf8"); }
function safeRecord(input: WorkLogMetadata): string {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) invalid("Recovery metadata must contain only bounded primitive values.");
  const entries = Object.entries(input);
  if (entries.length > 16) invalid("Recovery metadata has too many fields.");
  const safe: WorkLogMetadata = Object.create(null) as WorkLogMetadata;
  for (const [key, value] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) invalid("Recovery metadata field is invalid.");
    if (value === null || typeof value === "boolean") safe[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === "string" && value.length <= 512 && !value.includes("\0")) safe[key] = /password|passwd|pwd|api[_-]?key|token|secret|authorization/i.test(key) ? "[redacted]" : redactWorkText(value);
    else invalid("Recovery metadata value is invalid or too long.");
  }
  const serialized = JSON.stringify(safe);
  if (size(serialized) > MAX_METADATA_BYTES) invalid("Recovery metadata exceeds 4 KiB.");
  return serialized;
}
function safeCheckpoint(input: WorkCheckpointInput): string {
  if (!input || typeof input !== "object" || !["in_progress", "blocked", "completed"].includes(input.status)) invalid("Recovery checkpoint status is invalid.");
  requireText(input.goal, MAX_CHECKPOINT_BYTES, "Checkpoint goal");
  if (typeof input.nextStep !== "string" || input.nextStep.length > MAX_CHECKPOINT_BYTES || input.nextStep.includes("\0")) invalid("Checkpoint next step is invalid.");
  for (const [label, values] of [["Completed steps", input.completed], ["Verification", input.verification]] as const) {
    if (!Array.isArray(values) || values.length > 100) invalid(`${label} must be a bounded list.`);
    for (const value of values) requireText(value, MAX_CHECKPOINT_BYTES, label);
  }
  const payload: WorkCheckpointInput = { goal: input.goal, completed: input.completed, verification: input.verification, nextStep: input.nextStep, status: input.status };
  if (size(JSON.stringify(payload)) > MAX_CHECKPOINT_BYTES) invalid("Recovery checkpoint exceeds 8 KiB.");
  const redacted = { ...payload, goal: redactWorkText(input.goal), completed: input.completed.map(redactWorkText), verification: input.verification.map(redactWorkText), nextStep: redactWorkText(input.nextStep) };
  const serialized = JSON.stringify(redacted);
  if (size(serialized) > MAX_CHECKPOINT_BYTES) invalid("Recovery checkpoint exceeds 8 KiB after redaction.");
  return serialized;
}
function event(row: EventRow): WorkLogEvent {
  return {
    id: row.id, sequence: row.sequence, revision: row.revision, tool: row.tool,
    startedAt: row.started_at, endedAt: row.ended_at, status: row.status,
    mayHaveSideEffects: row.may_side_effect === 1, metadata: JSON.parse(row.metadata) as WorkLogMetadata,
    result: row.result ? JSON.parse(row.result) as WorkLogMetadata : null, reviewedAt: row.reviewed_at,
  };
}
