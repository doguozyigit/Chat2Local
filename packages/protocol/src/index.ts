/** A chat can use only the folder selected for it in Chat2Local. */
export interface ChatFolderConnection {
  id: string;
  title: string | null;
  setupCode: string;
  folderPath: string | null;
  revision: number;
  createdAt: string;
  lastSeenAt: string;
  recovery?: WorkRecoverySummary;
}

/** Local execution evidence does not establish that the host received a response. */
export interface WorkRecoverySummary {
  lastSavedAt: string | null;
  checkpointStatus: "in_progress" | "blocked" | "completed" | null;
  activeOperations: number;
  unresolvedOperations: number;
  reviewRequired: boolean;
  latestSequence: number;
}

export interface WorkCheckpointInput {
  goal: string;
  completed: string[];
  verification: string[];
  nextStep: string;
  status: "in_progress" | "blocked" | "completed";
}

export interface WorkCheckpoint extends WorkCheckpointInput {
  savedAt: string;
  sequence: number;
}

export type WorkLogMetadata = Record<string, string | number | boolean | null>;

export interface WorkLogEvent {
  id: string;
  sequence: number;
  revision: number;
  tool: string;
  startedAt: string;
  endedAt: string | null;
  status: "started" | "execution_recorded" | "execution_error" | "outcome_unknown";
  mayHaveSideEffects: boolean;
  metadata: WorkLogMetadata;
  result: WorkLogMetadata | null;
  reviewedAt: string | null;
}

export interface WorkLogPage {
  revision: number;
  folderPath: string | null;
  checkpoint: WorkCheckpoint | null;
  summary: WorkRecoverySummary;
  events: WorkLogEvent[];
  nextBeforeSequence: number | null;
}

export interface WorkLogRevision {
  revision: number;
  folderPath: string | null;
  lastSavedAt: string | null;
}

export interface TunnelStatus {
  enabled: boolean;
  connected: boolean;
  provider: string | null;
  tunnelId: string | null;
  publicEndpoint: string | null;
  state: "off" | "downloading" | "starting" | "propagating" | "connected" | "error";
  accessConfigured: boolean;
  error: string | null;
}
