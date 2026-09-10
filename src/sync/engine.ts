import type { ConflictResolutions, SyncBackend, SyncResult } from "./types";

export class SyncEngine {
  private running: Promise<SyncResult> | null = null;

  constructor(private readonly backend: SyncBackend) {}

  sync(): Promise<SyncResult> {
    if (this.running) {
      return this.running;
    }

    this.running = this.backend.sync().finally(() => {
      this.running = null;
    });

    return this.running;
  }

  getConflictPaths(): string[] {
    return this.backend.getConflictPaths?.() ?? [];
  }

  async resolveConflicts(resolutions: ConflictResolutions): Promise<SyncResult> {
    if (!this.backend.resolveConflicts) {
      throw new Error("This synchronization backend does not support in-app conflict resolution.");
    }

    if (this.running) {
      await this.running;
    }

    const resolve = this.backend.resolveConflicts.bind(this.backend);
    this.running = resolve(resolutions).finally(() => {
      this.running = null;
    });
    return await this.running;
  }
}
