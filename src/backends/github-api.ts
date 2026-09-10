import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  normalizePath,
  requestUrl,
  type App
} from "obsidian";
import { buildMobileMergePlan, type MobileMergePlan } from "../sync/mobile-plan";
import { isLocalOnlyPath } from "../sync/policy";
import type {
  ConflictResolutions,
  MobileSyncState,
  RepositoryBinding,
  SyncBackend,
  SyncResult
} from "../sync/types";

interface LocalEntry {
  sha: string;
  data: ArrayBuffer;
}

interface RemoteEntry {
  sha: string;
  mode: string;
}

interface RemoteSnapshot {
  commitSha: string;
  treeSha: string;
  files: Record<string, RemoteEntry>;
}

interface GitRefResponse {
  object: { sha: string };
}

interface GitCommitResponse {
  sha: string;
  tree: { sha: string };
}

interface GitTreeEntry {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string;
}

interface GitTreeResponse {
  sha: string;
  truncated: boolean;
  tree: GitTreeEntry[];
}

interface GitBlobResponse {
  sha: string;
  encoding: string;
  content: string;
}

interface CreatedObjectResponse {
  sha: string;
}

interface GitHubApiBackendOptions {
  tokenSecret: string;
  state: MobileSyncState;
  saveState: (state: MobileSyncState) => Promise<void>;
}

class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

const MAX_REMOTE_MOVE_RETRIES = 3;

/**
 * Mobile-safe synchronization backend.
 *
 * It treats the last synchronized Git tree as the merge base. Local files and
 * the current GitHub main tree are compared by Git blob SHA. Different-path
 * edits merge automatically; same-path divergent edits pause as conflicts.
 */
export class GitHubApiBackend implements SyncBackend {
  readonly kind = "github-api" as const;
  private pendingConflictPaths: string[] = [];

  constructor(
    private readonly app: App,
    private readonly binding: RepositoryBinding,
    private readonly options: GitHubApiBackendOptions
  ) {}

  async ensureReady(): Promise<void> {
    if (!this.binding.owner || !this.binding.name) {
      throw new Error("A GitHub repository must be configured.");
    }
    if (!this.options.tokenSecret) {
      throw new Error("Connect GitHub in Vault Sync settings for mobile synchronization.");
    }
    if (!this.accessToken()) {
      throw new Error("The selected GitHub credential is empty or unavailable.");
    }
  }

  async sync(): Promise<SyncResult> {
    await this.ensureReady();
    const token = this.accessToken();
    if (!token) {
      throw new Error("GitHub credential is unavailable.");
    }

    for (let attempt = 1; attempt <= MAX_REMOTE_MOVE_RETRIES; attempt += 1) {
      const result = await this.syncAttempt(token);
      if (result) {
        return result;
      }
    }

    throw new Error("Remote main kept changing during synchronization. Try again after the current writers finish.");
  }

  getConflictPaths(): string[] {
    return [...this.pendingConflictPaths];
  }

  async resolveConflicts(resolutions: ConflictResolutions): Promise<SyncResult> {
    await this.ensureReady();
    const token = this.accessToken();
    if (!token) {
      throw new Error("GitHub credential is unavailable.");
    }

    for (let attempt = 1; attempt <= MAX_REMOTE_MOVE_RETRIES; attempt += 1) {
      const result = await this.resolveAttempt(token, resolutions);
      if (result) {
        return result;
      }
    }

    throw new Error("Remote main kept changing while resolving conflicts. Try again after the current writers finish.");
  }

  private async syncAttempt(token: string): Promise<SyncResult | null> {
    const { repository, remote, local, plan } = await this.planCurrentState(token);

    if (plan.conflicts.length > 0) {
      this.pendingConflictPaths = [...plan.conflicts];
      return this.conflictResult(plan.conflicts);
    }

    this.pendingConflictPaths = [];
    return await this.executePlan(token, repository, remote, local, plan, false);
  }

  private async resolveAttempt(
    token: string,
    resolutions: ConflictResolutions
  ): Promise<SyncResult | null> {
    const { repository, remote, local, plan } = await this.planCurrentState(token);

    if (plan.conflicts.length === 0) {
      this.pendingConflictPaths = [];
      return await this.executePlan(token, repository, remote, local, plan, true);
    }

    const missing = plan.conflicts.filter((path) => resolutions[path] === undefined);
    if (missing.length > 0) {
      this.pendingConflictPaths = [...plan.conflicts];
      return {
        status: "conflict",
        changed: false,
        conflictPaths: [...plan.conflicts],
        message: `Conflict changed while resolving. Choose a version for: ${summarizePaths(missing)}`
      };
    }

    const desiredFiles = { ...plan.desiredFiles };
    const localShas = mapLocalShas(local);
    const remoteShas = mapRemoteShas(remote.files);
    for (const path of plan.conflicts) {
      const choice = resolutions[path];
      const selectedSha = choice === "local" ? localShas[path] : remoteShas[path];
      if (selectedSha === undefined) {
        delete desiredFiles[path];
      } else {
        desiredFiles[path] = selectedSha;
      }
    }

    const paths = new Set([
      ...Object.keys(localShas),
      ...Object.keys(remoteShas),
      ...Object.keys(desiredFiles)
    ]);
    const resolvedPlan: MobileMergePlan = {
      desiredFiles,
      conflicts: [],
      localApplyPaths: [...paths]
        .filter((path) => localShas[path] !== desiredFiles[path])
        .sort(),
      remoteChangePaths: [...paths]
        .filter((path) => remoteShas[path] !== desiredFiles[path])
        .sort()
    };

    const result = await this.executePlan(token, repository, remote, local, resolvedPlan, true);
    if (result) {
      this.pendingConflictPaths = [];
    }
    return result;
  }

  private async planCurrentState(token: string): Promise<{
    repository: string;
    remote: RemoteSnapshot;
    local: Record<string, LocalEntry>;
    plan: MobileMergePlan;
  }> {
    const remote = await this.readRemoteSnapshot(token);
    const local = await this.readLocalSnapshot();
    const repository = `${this.binding.owner}/${this.binding.name}`;
    const state = this.options.state.repository === repository
      ? this.options.state
      : { repository, baseCommit: "", baseFiles: {} };

    const localShas = mapLocalShas(local);
    const remoteShas = mapRemoteShas(remote.files);
    const plan = this.isFreshVaultBootstrap(state, localShas)
      ? buildRemoteBootstrapPlan(localShas, remoteShas)
      : buildMobileMergePlan(state.baseFiles, localShas, remoteShas);

    return { repository, remote, local, plan };
  }

  private async executePlan(
    token: string,
    repository: string,
    remote: RemoteSnapshot,
    local: Record<string, LocalEntry>,
    plan: MobileMergePlan,
    resolving: boolean
  ): Promise<SyncResult | null> {
    let synchronizedCommit = remote.commitSha;
    if (plan.remoteChangePaths.length > 0) {
      const createdCommit = await this.publishMergedTree(
        token,
        remote,
        local,
        plan.desiredFiles,
        plan.remoteChangePaths
      );
      if (!createdCommit) {
        return null;
      }
      synchronizedCommit = createdCommit;
    }

    await this.applyDesiredFiles(token, local, plan.desiredFiles, plan.localApplyPaths);
    const nextState: MobileSyncState = {
      repository,
      baseCommit: synchronizedCommit,
      baseFiles: { ...plan.desiredFiles }
    };
    this.options.state = nextState;
    await this.options.saveState(nextState);

    const changed = plan.remoteChangePaths.length > 0 || plan.localApplyPaths.length > 0;
    if (resolving) {
      return {
        status: "idle",
        changed,
        message: changed ? "Resolved conflicts and synchronized." : "Already synchronized."
      };
    }
    if (!changed) {
      return { status: "idle", changed: false, message: "Synced." };
    }
    if (plan.remoteChangePaths.length > 0 && plan.localApplyPaths.length > 0) {
      return { status: "idle", changed: true, message: "Merged local and remote changes." };
    }
    if (plan.remoteChangePaths.length > 0) {
      return { status: "idle", changed: true, message: "Pushed local changes." };
    }
    return { status: "idle", changed: true, message: "Pulled remote changes." };
  }

  private conflictResult(paths: string[]): SyncResult {
    return {
      status: "conflict",
      changed: false,
      conflictPaths: [...paths],
      message: `Local and remote changes conflict: ${summarizePaths(paths)}`
    };
  }

  private isFreshVaultBootstrap(
    state: MobileSyncState,
    localFiles: Record<string, string>
  ): boolean {
    if (state.baseCommit || Object.keys(state.baseFiles).length > 0) {
      return false;
    }

    const configDir = normalizePath(this.app.vault.configDir);
    const configPrefix = `${configDir}/`;
    return Object.keys(localFiles).every((path) => path === configDir || path.startsWith(configPrefix));
  }

  private async readRemoteSnapshot(token: string): Promise<RemoteSnapshot> {
    const commitSha = await this.readRemoteHead(token);
    const commit = await this.api<GitCommitResponse>("GET", `/git/commits/${commitSha}`, token);
    const tree = await this.api<GitTreeResponse>("GET", `/git/trees/${commit.tree.sha}?recursive=1`, token);

    if (tree.truncated) {
      throw new Error("GitHub returned a truncated repository tree; automatic mobile sync is paused.");
    }

    const files: Record<string, RemoteEntry> = {};
    for (const entry of tree.tree) {
      if (entry.type !== "blob" || !entry.path || !entry.sha) {
        continue;
      }
      const path = normalizePath(entry.path);
      if (isLocalOnlyPath(path, this.app.vault.configDir)) {
        throw new Error(`Remote main tracks device-local state (${path}). Remove it from Git before syncing this vault.`);
      }
      files[path] = {
        sha: entry.sha,
        mode: entry.mode ?? "100644"
      };
    }

    return { commitSha, treeSha: tree.sha, files };
  }

  private async readRemoteHead(token: string): Promise<string> {
    const ref = await this.api<GitRefResponse>("GET", "/git/ref/heads/main", token);
    return ref.object.sha;
  }

  private async readLocalSnapshot(): Promise<Record<string, LocalEntry>> {
    const paths = await this.listLocalFiles("");
    const files: Record<string, LocalEntry> = {};

    for (const rawPath of paths) {
      const path = normalizePath(rawPath);
      if (isLocalOnlyPath(path, this.app.vault.configDir)) {
        continue;
      }
      const data = await this.app.vault.adapter.readBinary(path);
      files[path] = {
        sha: await gitBlobSha(data),
        data
      };
    }

    return files;
  }

  private async listLocalFiles(directory: string): Promise<string[]> {
    const listed = await this.app.vault.adapter.list(directory);
    const files = [...listed.files];

    for (const rawFolder of listed.folders) {
      const folder = normalizePath(rawFolder);
      if (isLocalOnlyPath(`${folder}/`, this.app.vault.configDir)) {
        continue;
      }
      files.push(...await this.listLocalFiles(folder));
    }

    return files;
  }

  private async publishMergedTree(
    token: string,
    remote: RemoteSnapshot,
    local: Record<string, LocalEntry>,
    desiredFiles: Record<string, string>,
    changedPaths: string[]
  ): Promise<string | null> {
    const treeEntries: Array<Record<string, string | null>> = [];

    for (const path of changedPaths) {
      const desiredSha = desiredFiles[path];
      if (desiredSha === undefined) {
        treeEntries.push({
          path,
          mode: remote.files[path]?.mode ?? "100644",
          type: "blob",
          sha: null
        });
        continue;
      }

      const localEntry = local[path];
      if (!localEntry || localEntry.sha !== desiredSha) {
        throw new Error(`Cannot publish merged content for ${path}; the local blob is unavailable.`);
      }

      const blob = await this.api<CreatedObjectResponse>("POST", "/git/blobs", token, {
        content: arrayBufferToBase64(localEntry.data),
        encoding: "base64"
      });
      if (blob.sha !== desiredSha) {
        throw new Error(`GitHub blob identity mismatch while uploading ${path}.`);
      }

      treeEntries.push({
        path,
        mode: remote.files[path]?.mode ?? "100644",
        type: "blob",
        sha: blob.sha
      });
    }

    const tree = await this.api<CreatedObjectResponse>("POST", "/git/trees", token, {
      base_tree: remote.treeSha,
      tree: treeEntries
    });
    const commit = await this.api<CreatedObjectResponse>("POST", "/git/commits", token, {
      message: `Auto sync: ${new Date().toISOString()}`,
      tree: tree.sha,
      parents: [remote.commitSha]
    });

    if (await this.readRemoteHead(token) !== remote.commitSha) {
      return null;
    }

    try {
      await this.api("PATCH", "/git/refs/heads/main", token, {
        sha: commit.sha,
        force: false
      });
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 422) {
        const currentHead = await this.readRemoteHead(token);
        if (currentHead !== remote.commitSha) {
          return null;
        }
      }
      throw error;
    }

    return commit.sha;
  }

  private async applyDesiredFiles(
    token: string,
    local: Record<string, LocalEntry>,
    desiredFiles: Record<string, string>,
    paths: string[]
  ): Promise<void> {
    for (const path of paths) {
      const desiredSha = desiredFiles[path];
      if (desiredSha === undefined) {
        await this.deleteLocalFile(path);
        continue;
      }

      if (local[path]?.sha === desiredSha) {
        continue;
      }

      const blob = await this.api<GitBlobResponse>("GET", `/git/blobs/${desiredSha}`, token);
      if (blob.encoding !== "base64") {
        throw new Error(`Unsupported GitHub blob encoding for ${path}: ${blob.encoding}`);
      }
      await this.writeLocalFile(path, base64ToArrayBuffer(blob.content.replace(/\s/g, "")));
    }
  }

  private async writeLocalFile(path: string, data: ArrayBuffer): Promise<void> {
    const normalized = normalizePath(path);
    const file = this.app.vault.getFileByPath(normalized);
    if (file) {
      await this.app.vault.modifyBinary(file, data);
      return;
    }

    await this.ensureParentDirectories(normalized);
    const configPrefix = `${normalizePath(this.app.vault.configDir)}/`;
    if (normalized.startsWith(configPrefix)) {
      await this.app.vault.adapter.writeBinary(normalized, data);
      return;
    }

    if (await this.app.vault.adapter.exists(normalized)) {
      await this.app.vault.adapter.writeBinary(normalized, data);
      return;
    }
    await this.app.vault.createBinary(normalized, data);
  }

  private async deleteLocalFile(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const file = this.app.vault.getFileByPath(normalized);
    if (file) {
      await this.app.vault.delete(file, true);
      return;
    }
    if (await this.app.vault.adapter.exists(normalized)) {
      await this.app.vault.adapter.remove(normalized);
    }
  }

  private async ensureParentDirectories(path: string): Promise<void> {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join("/");
      if (!directory || await this.app.vault.adapter.exists(directory)) {
        continue;
      }
      await this.app.vault.adapter.mkdir(directory);
    }
  }

  private accessToken(): string | null {
    return this.app.secretStorage.getSecret(this.options.tokenSecret);
  }

  private async api<T = unknown>(
    method: string,
    path: string,
    token: string,
    body?: unknown
  ): Promise<T> {
    const owner = encodeURIComponent(this.binding.owner);
    const name = encodeURIComponent(this.binding.name);
    const response = await requestUrl({
      url: `https://api.github.com/repos/${owner}/${name}${path}`,
      method,
      contentType: body === undefined ? undefined : "application/json",
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });

    if (response.status < 200 || response.status >= 300) {
      const detail = response.text.trim();
      throw new GitHubApiError(
        `GitHub API ${method} ${path} failed with ${response.status}${detail ? `: ${detail}` : ""}`,
        response.status
      );
    }

    return response.json as T;
  }
}

function buildRemoteBootstrapPlan(
  localFiles: Record<string, string>,
  remoteFiles: Record<string, string>
): MobileMergePlan {
  const paths = new Set([...Object.keys(localFiles), ...Object.keys(remoteFiles)]);
  return {
    desiredFiles: { ...remoteFiles },
    conflicts: [],
    localApplyPaths: [...paths].filter((path) => localFiles[path] !== remoteFiles[path]).sort(),
    remoteChangePaths: []
  };
}

function mapLocalShas(files: Record<string, LocalEntry>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([path, entry]) => [path, entry.sha]));
}

function mapRemoteShas(files: Record<string, RemoteEntry>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([path, entry]) => [path, entry.sha]));
}

function summarizePaths(paths: string[]): string {
  const preview = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${preview} (+${paths.length - 3} more)` : preview;
}

async function gitBlobSha(data: ArrayBuffer): Promise<string> {
  const header = new TextEncoder().encode(`blob ${data.byteLength}\0`);
  const input = new Uint8Array(header.byteLength + data.byteLength);
  input.set(header, 0);
  input.set(new Uint8Array(data), header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
