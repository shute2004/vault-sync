import { Notice, Platform, Plugin, type EventRef } from "obsidian";
import { DesktopSyncBackend } from "./backends/desktop";
import { GitHubApiBackend } from "./backends/github-api";
import { ConflictResolutionModal } from "./conflict-modal";
import { DEFAULT_SETTINGS, type VaultSyncSettings, VaultSyncSettingTab } from "./settings";
import { SyncEngine } from "./sync/engine";
import { emptyMobileSyncState } from "./sync/types";
import type { RepositoryBinding, SyncBackend, SyncStatus } from "./sync/types";

export default class VaultSyncPlugin extends Plugin {
  settings: VaultSyncSettings = { ...DEFAULT_SETTINGS, mobileState: emptyMobileSyncState() };
  private engine: SyncEngine | null = null;
  private intervalId: number | null = null;
  private debounceId: number | null = null;
  private vaultEventRefs: EventRef[] = [];
  private statusBar: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new VaultSyncSettingTab(this.app, this));
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow(true) });
    this.addCommand({ id: "resolve-conflicts", name: "Resolve sync conflicts", callback: () => this.openConflictResolver() });
    this.statusBar = this.addStatusBarItem();
    this.setStatus("idle", "Not configured");
    this.app.workspace.onLayoutReady(() => {
      this.registerVaultEvents();
      this.reconfigure();
      void this.syncNow(false);
    });
  }

  onunload(): void {
    this.clearTimers();
    this.unregisterVaultEvents();
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData() as Partial<VaultSyncSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}), mobileState: loaded?.mobileState ?? emptyMobileSyncState() };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  reconfigure(): void {
    this.clearTimers();
    this.engine = this.createEngine();
    if (!this.engine) {
      this.setStatus("idle", "Not configured");
      return;
    }
    this.setStatus("idle", "Ready");
    const intervalMs = Math.max(30, this.settings.syncIntervalSeconds) * 1000;
    this.intervalId = window.setInterval(() => void this.syncNow(false), intervalMs);
    this.registerInterval(this.intervalId);
  }

  private registerVaultEvents(): void {
    const schedule = () => this.scheduleDebouncedSync();
    this.vaultEventRefs = [
      this.app.vault.on("create", schedule),
      this.app.vault.on("modify", schedule),
      this.app.vault.on("delete", schedule),
      this.app.vault.on("rename", schedule)
    ];
  }

  private unregisterVaultEvents(): void {
    for (const eventRef of this.vaultEventRefs) this.app.vault.offref(eventRef);
    this.vaultEventRefs = [];
  }

  private scheduleDebouncedSync(): void {
    if (!this.engine) return;
    if (this.debounceId !== null) window.clearTimeout(this.debounceId);
    const delayMs = Math.max(5, this.settings.debounceSeconds) * 1000;
    this.debounceId = window.setTimeout(() => {
      this.debounceId = null;
      void this.syncNow(false);
    }, delayMs);
  }

  private createEngine(): SyncEngine | null {
    const binding = parseRepository(this.settings.repository);
    if (!binding) return null;
    const backend: SyncBackend = Platform.isDesktopApp
      ? new DesktopSyncBackend(this.app, binding, { tokenSecret: this.settings.githubTokenSecret })
      : new GitHubApiBackend(this.app, binding, {
          tokenSecret: this.settings.githubTokenSecret,
          state: this.settings.mobileState,
          saveState: async (state) => {
            this.settings.mobileState = state;
            await this.saveSettings();
          }
        });
    return new SyncEngine(backend);
  }

  private async syncNow(showNotice: boolean): Promise<void> {
    if (!this.engine) {
      if (showNotice) new Notice("Vault Sync: configure a GitHub repository first.");
      return;
    }
    this.setStatus("syncing", "Syncing...");
    try {
      const result = await this.engine.sync();
      this.setStatus(result.status, result.message ?? "Synced");
      if (showNotice && result.message) new Notice(`Vault Sync: ${result.message}`);
      if (showNotice && result.status === "conflict" && this.engine.getConflictPaths().length > 0) this.openConflictResolver();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("error", message);
      new Notice(`Vault Sync failed: ${message}`);
    }
  }

  private openConflictResolver(): void {
    const engine = this.engine;
    if (!engine) {
      new Notice("Vault Sync: configure a GitHub repository first.");
      return;
    }
    const paths = engine.getConflictPaths();
    if (paths.length === 0) {
      new Notice("Vault Sync: there are no unresolved sync conflicts.");
      return;
    }
    new ConflictResolutionModal(this.app, paths, async (resolutions) => {
      this.setStatus("syncing", "Resolving conflicts...");
      try {
        const result = await engine.resolveConflicts(resolutions);
        this.setStatus(result.status, result.message ?? "Synced");
        new Notice(`Vault Sync: ${result.message ?? "Conflicts resolved."}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus("error", message);
        new Notice(`Vault Sync failed: ${message}`);
        throw error;
      }
    }).open();
  }

  private setStatus(status: SyncStatus, message: string): void {
    if (!this.statusBar) return;
    const marker: Record<SyncStatus, string> = { idle: "✓", syncing: "↑", pulling: "↓", pushing: "↑", conflict: "!", error: "×" };
    this.statusBar.setText(`${marker[status]} Vault Sync: ${message}`);
  }

  private clearTimers(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.debounceId !== null) {
      window.clearTimeout(this.debounceId);
      this.debounceId = null;
    }
  }
}

function parseRepository(value: string): RepositoryBinding | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") return null;
    const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    const owner = segments[0];
    const rawName = segments[1];
    if (!owner || !rawName) return null;
    const name = rawName.replace(/\.git$/, "");
    return { owner, name, branch: "main", remoteUrl: `https://github.com/${owner}/${name}.git` };
  } catch {
    return null;
  }
}
