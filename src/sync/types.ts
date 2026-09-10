export type SyncStatus =
  | "idle"
  | "syncing"
  | "pulling"
  | "pushing"
  | "conflict"
  | "error";

export interface RepositoryBinding {
  owner: string;
  name: string;
  branch: "main";
  remoteUrl: string;
}

export interface MobileSyncState {
  repository: string;
  baseCommit: string;
  baseFiles: Record<string, string>;
}

export function emptyMobileSyncState(): MobileSyncState {
  return {
    repository: "",
    baseCommit: "",
    baseFiles: {}
  };
}

export type ConflictResolutionChoice = "local" | "remote";
export type ConflictResolutions = Record<string, ConflictResolutionChoice>;

export interface SyncResult {
  status: SyncStatus;
  changed: boolean;
  message?: string;
  conflictPaths?: string[];
}

export interface SyncBackend {
  readonly kind: "desktop-git" | "github-api";
  ensureReady(): Promise<void>;
  sync(): Promise<SyncResult>;
  getConflictPaths?(): string[];
  resolveConflicts?(resolutions: ConflictResolutions): Promise<SyncResult>;
}
