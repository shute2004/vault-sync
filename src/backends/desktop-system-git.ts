import { FileSystemAdapter, Platform, type App } from "obsidian";
import { defaultLocalOnlyPaths } from "../sync/policy";
import type { RepositoryBinding, SyncBackend, SyncResult } from "../sync/types";

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

interface DesktopGitBackendOptions {
  tokenSecret?: string;
}

class GitCommandError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
  }
}

const MAX_REMOTE_MOVE_RETRIES = 3;
const DEFAULT_GIT_AUTHOR_NAME = "Vault Sync";
const DEFAULT_GIT_AUTHOR_EMAIL = "vault-sync@users.noreply.github.com";
const EXCLUDE_BLOCK_START = "# BEGIN Vault Sync local-only";
const EXCLUDE_BLOCK_END = "# END Vault Sync local-only";

export class DesktopSystemGitBackend implements SyncBackend {
  readonly kind = "desktop-git" as const;

  constructor(
    private readonly app: App,
    private readonly binding: RepositoryBinding,
    private readonly options: DesktopGitBackendOptions = {}
  ) {}

  async ensureReady(): Promise<void> {
    if (!Platform.isDesktopApp) {
      throw new Error("System Git backend is only available on desktop.");
    }
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
      throw new Error("Vault Sync requires a filesystem-backed vault on desktop.");
    }

    await this.runGit(["--version"]);
    const root = this.vaultRoot();
    const inside = await this.tryGit(["-C", root, "rev-parse", "--is-inside-work-tree"]);
    if (!inside || inside.stdout.trim() !== "true") {
      await this.bootstrapVault(root);
    }

    const branch = (await this.runGit(["-C", root, "branch", "--show-current"])).stdout.trim();
    if (branch !== this.binding.branch) {
      throw new Error(`Vault Sync only synchronizes main; current branch is ${branch || "detached HEAD"}.`);
    }

    const origin = (await this.runGit(["-C", root, "remote", "get-url", "origin"])).stdout.trim();
    if (!sameGitHubRepository(origin, this.binding.remoteUrl)) {
      throw new Error("The vault's origin remote does not match the configured GitHub repository.");
    }

    await this.assertProtectedPathsAreUntracked(root);
    await this.ensureLocalGitExcludes(root);
    await this.ensureLocalGitIdentity(root);
  }

  async sync(): Promise<SyncResult> {
    await this.ensureReady();
    const root = this.vaultRoot();

    if (await this.hasUnmergedPaths(root)) {
      return {
        status: "conflict",
        changed: true,
        message: "Git conflict detected. Automatic synchronization is paused."
      };
    }

    await this.commitLocalChanges(root);

    for (let attempt = 1; attempt <= MAX_REMOTE_MOVE_RETRIES; attempt += 1) {
      await this.fetchMain(root);
      await this.assertRemoteProtectedPathsAreUntracked(root);
      const localHead = await this.head(root);
      const remoteHead = await this.remoteHead(root);

      if (localHead === remoteHead) {
        return { status: "idle", changed: false, message: "Synced." };
      }
      if (await this.isAncestor(root, localHead, remoteHead)) {
        await this.runGit(["-C", root, "merge", "--ff-only", "origin/main"]);
        return { status: "idle", changed: true, message: "Pulled remote changes." };
      }
      if (await this.isAncestor(root, remoteHead, localHead)) {
        if (await this.tryPush(root)) {
          return { status: "idle", changed: true, message: "Pushed local changes." };
        }
        continue;
      }

      const rebased = await this.tryRebase(root);
      if (!rebased) {
        return {
          status: "conflict",
          changed: true,
          message: "Local and remote changes conflict. Automatic synchronization is paused."
        };
      }
      if (await this.tryPush(root)) {
        return { status: "idle", changed: true, message: "Merged local and remote changes." };
      }
    }

    throw new Error("Remote main kept changing during synchronization. Try again after the current writers finish.");
  }

  private async bootstrapVault(root: string): Promise<void> {
    const remoteMain = await this.runGit(["ls-remote", this.binding.remoteUrl, "refs/heads/main"]);
    const hasRemoteMain = remoteMain.stdout.trim().length > 0;
    if (hasRemoteMain) {
      await this.assertFilesystemSafeForBootstrap(root);
    }

    let keepGitMetadata = false;
    try {
      await this.runGit(["-C", root, "init", "-b", "main"]);
      await this.runGit(["-C", root, "remote", "add", "origin", this.binding.remoteUrl]);
      await this.ensureLocalGitExcludes(root);
      await this.ensureLocalGitIdentity(root);

      if (hasRemoteMain) {
        await this.fetchMain(root);
        await this.assertRemoteProtectedPathsAreUntracked(root);
        keepGitMetadata = true;
        await this.runGit(["-C", root, "reset", "--hard", "origin/main"]);
        return;
      }

      await this.commitInitialVault(root);
      try {
        await this.runGit(["-C", root, "push", "-u", "origin", "HEAD:main"]);
        keepGitMetadata = true;
      } catch (error) {
        if (!(error instanceof GitCommandError) || !/non-fast-forward|fetch first|rejected/i.test(error.stderr)) {
          throw error;
        }
        await this.fetchMain(root);
        await this.assertRemoteProtectedPathsAreUntracked(root);
        keepGitMetadata = true;
      }
    } catch (error) {
      if (!keepGitMetadata) {
        await this.removeGitMetadata(root);
      }
      throw error;
    }
  }

  private async commitInitialVault(root: string): Promise<void> {
    await this.runGit(["-C", root, "add", "-A", "--", "."]);
    await this.runGit(["-C", root, "commit", "--allow-empty", "-m", "Initialize Vault Sync"]);
  }

  private async assertFilesystemSafeForBootstrap(root: string): Promise<void> {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(root, { withFileTypes: true });
    const configRoot = this.app.vault.configDir.replaceAll("\\", "/").split("/")[0];
    const allowed = new Set([configRoot, ".trash"]);
    const unexpected = entries.map((entry) => entry.name).filter((name) => !allowed.has(name));
    if (unexpected.length > 0) {
      throw new Error(
        `This vault contains existing filesystem content (${unexpected.slice(0, 3).join(", ")}${unexpected.length > 3 ? ", ..." : ""}). Vault Sync will not overwrite it during repository bootstrap.`
      );
    }
  }

  private async removeGitMetadata(root: string): Promise<void> {
    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await rm(join(root, ".git"), { recursive: true, force: true });
  }

  private async ensureLocalGitExcludes(root: string): Promise<void> {
    const gitPath = (await this.runGit(["-C", root, "rev-parse", "--git-path", "info/exclude"])).stdout.trim();
    const { mkdir, readFile, writeFile } = await import("node:fs/promises");
    const { dirname, isAbsolute, join } = await import("node:path");
    const excludePath = isAbsolute(gitPath) ? gitPath : join(root, gitPath);

    let existing = "";
    try {
      existing = await readFile(excludePath, "utf8");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    let unmanaged = existing;
    const start = unmanaged.indexOf(EXCLUDE_BLOCK_START);
    if (start >= 0) {
      const end = unmanaged.indexOf(EXCLUDE_BLOCK_END, start);
      if (end >= 0) {
        unmanaged = `${unmanaged.slice(0, start)}${unmanaged.slice(end + EXCLUDE_BLOCK_END.length)}`;
      }
    }

    const patterns = defaultLocalOnlyPaths(this.app.vault.configDir)
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => path !== ".git/")
      .map((path) => `/${path}`);
    const block = [EXCLUDE_BLOCK_START, ...patterns, EXCLUDE_BLOCK_END].join("\n");
    const prefix = unmanaged.trimEnd();
    await mkdir(dirname(excludePath), { recursive: true });
    await writeFile(excludePath, prefix ? `${prefix}\n\n${block}\n` : `${block}\n`, "utf8");
  }

  private async ensureLocalGitIdentity(root: string): Promise<void> {
    const name = await this.tryGit(["-C", root, "config", "--local", "--get", "user.name"]);
    if (!name?.stdout.trim()) {
      await this.runGit(["-C", root, "config", "--local", "user.name", DEFAULT_GIT_AUTHOR_NAME]);
    }
    const email = await this.tryGit(["-C", root, "config", "--local", "--get", "user.email"]);
    if (!email?.stdout.trim()) {
      await this.runGit(["-C", root, "config", "--local", "user.email", DEFAULT_GIT_AUTHOR_EMAIL]);
    }
  }

  private async commitLocalChanges(root: string): Promise<void> {
    await this.runGit(["-C", root, "add", "-A", "--", "."]);
    const clean = await this.tryGit(["-C", root, "diff", "--cached", "--quiet", "--exit-code"]);
    if (clean) {
      return;
    }
    await this.runGit(["-C", root, "commit", "-m", `Auto sync: ${new Date().toISOString()}`]);
  }

  private async fetchMain(root: string): Promise<void> {
    await this.runGit(["-C", root, "fetch", "--prune", "origin", "main"]);
  }

  private async head(root: string): Promise<string> {
    return (await this.runGit(["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  }

  private async remoteHead(root: string): Promise<string> {
    return (await this.runGit(["-C", root, "rev-parse", "origin/main"])).stdout.trim();
  }

  private async isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
    return await this.tryGit(["-C", root, "merge-base", "--is-ancestor", ancestor, descendant]) !== null;
  }

  private async tryRebase(root: string): Promise<boolean> {
    try {
      await this.runGit(["-C", root, "rebase", "origin/main"]);
      return true;
    } catch (error) {
      if (await this.hasUnmergedPaths(root)) {
        return false;
      }
      throw error;
    }
  }

  private async tryPush(root: string): Promise<boolean> {
    try {
      await this.runGit(["-C", root, "push", "origin", "HEAD:main"]);
      return true;
    } catch (error) {
      if (error instanceof GitCommandError && /non-fast-forward|fetch first|rejected/i.test(error.stderr)) {
        return false;
      }
      throw error;
    }
  }

  private async hasUnmergedPaths(root: string): Promise<boolean> {
    return (await this.runGit(["-C", root, "diff", "--name-only", "--diff-filter=U"])).stdout.trim().length > 0;
  }

  private async assertProtectedPathsAreUntracked(root: string): Promise<void> {
    for (const path of defaultLocalOnlyPaths(this.app.vault.configDir)) {
      const normalized = stripTrailingSlash(path);
      const tracked = await this.runGit(["-C", root, "ls-files", "--", normalized]);
      if (tracked.stdout.trim()) {
        throw new Error(`Device-local Obsidian state is tracked by Git (${normalized}). Untrack it before enabling automatic sync.`);
      }
    }
  }

  private async assertRemoteProtectedPathsAreUntracked(root: string): Promise<void> {
    for (const path of defaultLocalOnlyPaths(this.app.vault.configDir)) {
      const normalized = stripTrailingSlash(path);
      const tracked = await this.runGit(["-C", root, "ls-tree", "-r", "--name-only", "origin/main", "--", normalized]);
      if (tracked.stdout.trim()) {
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

  private async tryGit(args: string[]): Promise<GitCommandResult | null> {
    try {
      return await this.runGit(args);
    } catch {
      return null;
    }
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

function stripTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function sameGitHubRepository(a: string, b: string): boolean {
  return normalizeRemote(a) === normalizeRemote(b);
}

function normalizeRemote(value: string): string {
  return value
    .trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}
