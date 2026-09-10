import { App, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type VaultSyncPlugin from "./main";
import { emptyMobileSyncState, type MobileSyncState } from "./sync/types";

export interface VaultSyncSettings {
  repository: string;
  githubTokenSecret: string;
  syncIntervalSeconds: number;
  debounceSeconds: number;
  mobileState: MobileSyncState;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
  repository: "",
  githubTokenSecret: "",
  syncIntervalSeconds: 300,
  debounceSeconds: 60,
  mobileState: emptyMobileSyncState()
};

export class VaultSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: VaultSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    this.containerEl.empty();

    new Setting(this.containerEl)
      .setName("GitHub repository")
      .setDesc("Repository URL for this vault. One repository maps to one vault and synchronization always targets main.")
      .addText((text) =>
        text
          .setPlaceholder("https://github.com/owner/repository")
          .setValue(this.plugin.settings.repository)
          .onChange(async (value) => {
            this.plugin.settings.repository = value.trim();
            await this.plugin.saveSettings();
            this.plugin.reconfigure();
          })
      );

    new Setting(this.containerEl)
      .setName("GitHub access token")
      .setDesc("Select or create a SecretStorage entry containing a fine-grained GitHub token with Contents read/write permission for this repository. Mobile requires it. Desktop uses it when configured and otherwise falls back to the system Git credential helper. The token value is never stored in Vault Sync data.json.")
      .addComponent((element) =>
        new SecretComponent(this.app, element)
          .setValue(this.plugin.settings.githubTokenSecret)
          .onChange(async (value) => {
            this.plugin.settings.githubTokenSecret = value;
            await this.plugin.saveSettings();
            this.plugin.reconfigure();
          })
      );

    new Setting(this.containerEl)
      .setName("Remote check interval")
      .setDesc("Seconds between background checks while Obsidian is open.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.syncIntervalSeconds)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed >= 30) {
            this.plugin.settings.syncIntervalSeconds = parsed;
            await this.plugin.saveSettings();
            this.plugin.reconfigure();
          }
        })
      );

    new Setting(this.containerEl)
      .setName("Commit debounce")
      .setDesc("Seconds of inactivity before local changes become eligible for automatic sync.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.debounceSeconds)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed >= 5) {
            this.plugin.settings.debounceSeconds = parsed;
            await this.plugin.saveSettings();
          }
        })
      );
  }
}
