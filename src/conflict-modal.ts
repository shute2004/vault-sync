import { Modal, Notice, Setting, type App } from "obsidian";
import type { ConflictResolutionChoice, ConflictResolutions } from "./sync/types";

export class ConflictResolutionModal extends Modal {
  private readonly selections: Record<string, ConflictResolutionChoice | ""> = {};

  constructor(
    app: App,
    private readonly paths: string[],
    private readonly onResolve: (resolutions: ConflictResolutions) => Promise<void>
  ) {
    super(app);
    for (const path of paths) {
      this.selections[path] = "";
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Resolve Vault Sync conflicts" });
    contentEl.createEl("p", {
      text: "Choose which complete file version to keep for each conflict. Non-conflicting changes from both sides are preserved."
    });

    for (const path of this.paths) {
      new Setting(contentEl)
        .setName(path)
        .setDesc("This device keeps the current local file. GitHub keeps the current main version.")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("", "Choose a version…")
            .addOption("local", "This device")
            .addOption("remote", "GitHub")
            .setValue(this.selections[path] ?? "")
            .onChange((value) => {
              if (value === "local" || value === "remote" || value === "") {
                this.selections[path] = value;
              }
            })
        );
    }

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("Resolve and sync")
          .setCta()
          .onClick(async () => {
            const unresolved = this.paths.filter((path) => !this.selections[path]);
            if (unresolved.length > 0) {
              new Notice(`Choose a version for ${unresolved.length} conflicted file${unresolved.length === 1 ? "" : "s"}.`);
              return;
            }

            const resolutions: ConflictResolutions = {};
            for (const path of this.paths) {
              const choice = this.selections[path];
              if (choice === "local" || choice === "remote") {
                resolutions[path] = choice;
              }
            }

            button.setDisabled(true);
            try {
              await this.onResolve(resolutions);
              this.close();
            } finally {
              button.setDisabled(false);
            }
          })
      )
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
