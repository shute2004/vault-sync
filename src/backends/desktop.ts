import { FileSystemAdapter, type App } from "obsidian";
import { defaultLocalOnlyPaths } from "../sync/policy";
import type {
  ConflictResolutions,
  RepositoryBinding,
  SyncBackend,
  SyncResult
} from "../sync/types";
import { DesktopSystemGitBackend } from "./desktop-system-git";

interface DesktopBackendOptions {
  tokenSecret?: string;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

class GitCommandError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
  }
}

export class DesktopSyncBackend implements SyncBackend {
  readonly kind = "desktop-git" as const;
  private readonly inner: DesktopSystemGitBackend;
  private pendingConflictPaths: string[] = [];

  constructor(
    private readonly app: App,
    private readonly binding: RepositoryBinding,
    private readonly options: DesktopBackendOptions = {}
  ) {
    this.inner = new DesktopSystemGitBackend(app, binding, options);
  }

  ensureReady(): Promise<void> {
    return this.inner.ensureReady();
  }

  async sync(): Promise<SyncResult> {
    const result = await this.inner.sync();
    if (result.status !== "conflict") {
      this.pendingConflictPaths = [];
      return result;
    }

    const root = this.vaultRoot();
    const paths = await this.unmergedPaths(root);
    if (paths.length > 0) {
      await this.abortPluginGitOperation(root);
      this.pendingConflictPaths = paths;
    }

    return {
      ...result,
      conflictPaths: [...this.pendingConflictPaths],
      message: this.pendingConflictPaths.length > 0
        ? `Conflicting files need a choice: ${summarizePaths(this.pendingConflictPaths)}`
        : result.message
    };
  }

  getConflictPaths(): string[] {
    return [...this.pendingConflictPaths];
  }

  async resolveConflicts(resolutions: ConflictResolutions): Promise<SyncResult> {
    const refreshed = await this.sync();
    if (refreshed.status !== "conflict") {
      return refreshed;
    }

    const root = this.vaultRoot();
    await this.runGit(["-C", root, "fetch", "--prune", "origin", "main"]);
    await this.assertRemoteProtectedPathsAreUntracked(root);

    const merge = await this.tryMerge(root);
    if (merge.clean) {
      this.pendingConflictPaths = [];
      return await this.sync();
    }

    const paths = await this.unmergedPaths(root);
    const missing = paths.filter((path) => resolutions[path] === undefined);
    if (missing.length > 0) {
      await this.abortMerge(root);
      this.pendingConflictPaths = paths;
      return {
        status: "conflict",
        changed: false,
        conflictPaths: [...paths],
        message: `Conflict changed while resolving. Choose a version for: ${summarizePaths(missing)}`
      };
    }

    try {
      for (const path of paths) {
        const choice = resolutions[path];
        if (!choice) {
          throw new Error(`Missing conflict resolution for ${path}.`);
        }
        await this.applyRefVersion(root, choice === "local" ? "HEAD" : "origin/main", path);
      }

      const remaining = await this.unmergedPaths(root);
      if (remaining.length > 0) {
        throw new Error(`Git still reports unresolved paths: ${remaining.join(", ")}`);
      }

      await this.runGit(["-C", root, "commit", "-m", "Resolve Vault Sync conflict"]);
    } catch (error) {
      await this.abortMerge(root);
      throw error;
    }

    this.pendingConflictPaths = [];
    const result = await this.sync();
    if (result.status === "conflict") {
      return result;
    }
    return {
      ...result,
      changed: true,
      message: "Resolved conflicts and synchronized."
    };
  }

  private async tryMerge(root: string): Promise<{ clean: boolean }> {
    try {
      await this.runGit(["-C", root, "merge", "--no-edit", "origin/main"]);
      return { clean: true };
    } catch (error) {
      const paths = await this.unmergedPaths(root);
      if (paths.length > 0) {
        return { clean: false };
      }
      throw error;
    }
  }

  private async applyRefVersion(root: string, ref: string, path: string): Promise<void> {
    if (await this.refHasPath(root, ref, path)) {
      await this.runGit(["-C", root, "checkout", ref, "--", path]);
    } else {
      await this.runGit(["-C", root, "rm", "-f", "--ignore-unmatch", "--", path]);
    }
    await this.runGit(["-C", root, "add", "-A", "--", path]);
  }

  private async refHasPath(root: string, ref: string, path: string): Promise<boolean> {
    const result = await this.runGit(["-C", root, "ls-tree", "-r", "--name-only", ref, "--", path]);
    return result.stdout.split("\n").some((line) => line.trim() === path);
  }

  private async abortPluginGitOperation(root: string): Promise<void> {
    if (await this.gitPathExists(root, "rebase-merge") || await this.gitPathExists(root, "rebase-apply")) {
      await this.runGit(["-C", root, "rebase", "--abort"]);
      return;
    }
    if (await this.gitPathExists(root, "MERGE_HEAD")) {
      await this.abortMerge(root);
    }
  }

  private async abortMerge(root: string): Promise<void> {
    if (await this.gitPathExists(root, "MERGE_HEAD")) {
      await this.runGit(["-C", root, "merge", "--abort"]);
    }
  }

  private async gitPathExists(root: string, name: string): Promise<boolean> {
    const gitPath = (await this.runGit(["-C", root, "rev-parse", "--git-path", name])).stdout.trim();
    const { access } = await import("node:fs/promises");
    const { isAbsolute, join } = await import("node:path");
    const resolved = isAbsolute(gitPath) ? gitPath : join(root, gitPath);
    try {
      await access(resolved);
      return true;
    } catch {
      return false;
    }
  }

  private async unmergedPaths(root: string): Promise<string[]> {
    const result = await this.runGit(["-C", root, "diff", "--name-only", "--diff-filter=U"]);
    return result.stdout
      .split("\n")
      .map((path) => path.trim())
      .filter(Boolean)
      .sort();
  }

  private async assertRemoteProtectedPathsAreUntracked(root: string): Promise<void> {
    for (const path of defaultLocalOnlyPaths(this.app.vault.configDir)) {
      const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
      const result = await this.runGit([
        "-C",
        root,
        "ls-tree",
        "-r",
        "--name-only",
        "origin/main",
        "--",
        normalized
      ]);
      if (result.stdout.trim()) {
        throw new Error(`Remote main tracks device-local Obsidian state (${normalized}). Remove it from Git before syncing this vault.`);
      }
    }
  }

  private vaultRoot(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Filesystem adapter is unavailable.");
    }
    return adapter.getBasePath();
  }

  private accessToken(): string {
    const secretName = this.options.tokenSecret?.trim();
    return secretName ? this.app.secretStorage.getSecret(secretName) ?? "" : "";
  }

  private async gitEnvironment(): Promise<NodeJS.ProcessEnv | undefined> {
    const token = this.accessToken();
    if (!token) {
      return undefined;
    }
    const { env } = await import("node:process");
    const authorization = btoa(`x-access-token:${token}`);
    return {
      ...env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
      GIT_TERMINAL_PROMPT: "0"
    };
  }

  private async runGit(args: string[]): Promise<GitCommandResult> {
    const { execFile } = await import("node:child_process");
    const env = await this.gitEnvironment();
    return await new Promise<GitCommandResult>((resolve, reject) => {
      execFile("git", args, { encoding: "utf8", env }, (error, stdout, stderr) => {
        if (error) {
          reject(new GitCommandError(stderr.trim() || error.message, stderr));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}

function summarizePaths(paths: string[]): string {
  const preview = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${preview} (+${paths.length - 3} more)` : preview;
}
