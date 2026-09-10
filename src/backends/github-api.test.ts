import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizePath,
  setRequestUrlHandler,
  type RequestUrlParam,
  type RequestUrlResponse
} from "../../test/obsidian-runtime";
import { GitHubApiBackend } from "./github-api";
import { emptyMobileSyncState, type MobileSyncState } from "../sync/types";

interface TreeEntry { sha: string; mode: string; }
interface CommitRecord { tree: string; parents: string[]; }

function arrayBufferFromText(value: string): ArrayBuffer { return new TextEncoder().encode(value).buffer; }
function copyArrayBuffer(data: ArrayBuffer): ArrayBuffer { return new Uint8Array(data).slice().buffer; }
async function gitBlobSha(data: ArrayBuffer): Promise<string> {
  const header = new TextEncoder().encode(`blob ${data.byteLength}\0`);
  const input = new Uint8Array(header.byteLength + data.byteLength);
  input.set(header, 0); input.set(new Uint8Array(data), header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

class FakeGitHub {
  private readonly blobs = new Map<string, ArrayBuffer>();
  private readonly trees = new Map<string, Record<string, TreeEntry>>();
  private readonly commits = new Map<string, CommitRecord>();
  private treeCounter = 0; private commitCounter = 0; private refReadCount = 0;
  private raceAtRefRead: number | null = null;
  private raceChanges: Record<string, string | null> = {};
  head = "";

  async initialize(files: Record<string, string>): Promise<void> {
    const entries: Record<string, TreeEntry> = {};
    for (const [path, text] of Object.entries(files)) {
      const data = arrayBufferFromText(text); const sha = await gitBlobSha(data);
      this.blobs.set(sha, data); entries[path] = { sha, mode: "100644" };
    }
    const tree = this.storeTree(entries); this.head = this.storeCommit(tree, []);
  }
  scheduleRace(refReadNumber: number, changes: Record<string, string | null>): void { this.raceAtRefRead = refReadNumber; this.raceChanges = changes; }
  async directCommit(changes: Record<string, string | null>): Promise<void> {
    const base = this.currentFiles();
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) { delete base[path]; continue; }
      const data = arrayBufferFromText(text); const sha = await gitBlobSha(data);
      this.blobs.set(sha, data); base[path] = { sha, mode: "100644" };
    }
    const tree = this.storeTree(base); this.head = this.storeCommit(tree, [this.head]);
  }
  async readText(path: string): Promise<string | null> {
    const entry = this.currentFiles()[path]; if (!entry) return null;
    const data = this.blobs.get(entry.sha); return data ? new TextDecoder().decode(data) : null;
  }
  handle = async (request: RequestUrlParam): Promise<RequestUrlResponse> => {
    const url = new URL(request.url); const prefix = "/repos/test/repo";
    if (!url.pathname.startsWith(prefix)) return this.response(404, { message: "unknown repository" });
    const path = `${url.pathname.slice(prefix.length)}${url.search}`; const method = request.method ?? "GET";
    if (method === "GET" && path === "/git/ref/heads/main") {
      this.refReadCount += 1;
      if (this.raceAtRefRead === this.refReadCount) { this.raceAtRefRead = null; await this.directCommit(this.raceChanges); }
      return this.response(200, { object: { sha: this.head } });
    }
    const commitMatch = path.match(/^\/git\/commits\/([^?]+)$/);
    if (method === "GET" && commitMatch) {
      const sha = commitMatch[1] ?? ""; const commit = this.commits.get(sha);
      return commit ? this.response(200, { sha, tree: { sha: commit.tree } }) : this.response(404, { message: "commit not found" });
    }
    const treeMatch = path.match(/^\/git\/trees\/([^?]+)\?recursive=1$/);
    if (method === "GET" && treeMatch) {
      const sha = treeMatch[1] ?? ""; const tree = this.trees.get(sha);
      if (!tree) return this.response(404, { message: "tree not found" });
      return this.response(200, { sha, truncated: false, tree: Object.entries(tree).map(([entryPath, entry]) => ({ path: entryPath, mode: entry.mode, type: "blob", sha: entry.sha })) });
    }
    const blobMatch = path.match(/^\/git\/blobs\/([^?]+)$/);
    if (method === "GET" && blobMatch) {
      const sha = blobMatch[1] ?? ""; const data = this.blobs.get(sha);
      return data ? this.response(200, { sha, encoding: "base64", content: Buffer.from(new Uint8Array(data)).toString("base64") }) : this.response(404, { message: "blob not found" });
    }
    if (method === "POST" && path === "/git/blobs") {
      const body = this.body(request) as { content: string; encoding: string };
      if (body.encoding !== "base64") return this.response(422, { message: "encoding" });
      const data = Uint8Array.from(Buffer.from(body.content, "base64")).buffer; const sha = await gitBlobSha(data);
      this.blobs.set(sha, data); return this.response(201, { sha });
    }
    if (method === "POST" && path === "/git/trees") {
      const body = this.body(request) as { base_tree: string; tree: Array<{ path: string; mode: string; type: string; sha: string | null }> };
      const base = this.trees.get(body.base_tree); if (!base) return this.response(422, { message: "base tree" });
      const next = structuredClone(base);
      for (const entry of body.tree) { if (entry.sha === null) delete next[entry.path]; else next[entry.path] = { sha: entry.sha, mode: entry.mode }; }
      return this.response(201, { sha: this.storeTree(next) });
    }
    if (method === "POST" && path === "/git/commits") {
      const body = this.body(request) as { tree: string; parents: string[] };
      if (!this.trees.has(body.tree)) return this.response(422, { message: "tree" });
      return this.response(201, { sha: this.storeCommit(body.tree, body.parents) });
    }
    if (method === "PATCH" && path === "/git/refs/heads/main") {
      const body = this.body(request) as { sha: string; force: boolean }; const commit = this.commits.get(body.sha);
      if (!commit || body.force || commit.parents[0] !== this.head) return this.response(422, { message: "non-fast-forward" });
      this.head = body.sha; return this.response(200, { object: { sha: this.head } });
    }
    return this.response(404, { message: `${method} ${path}` });
  };
  private currentFiles(): Record<string, TreeEntry> { const commit = this.commits.get(this.head); return commit ? structuredClone(this.trees.get(commit.tree) ?? {}) : {}; }
  private storeTree(files: Record<string, TreeEntry>): string { const sha = `tree-${++this.treeCounter}`; this.trees.set(sha, structuredClone(files)); return sha; }
  private storeCommit(tree: string, parents: string[]): string { const sha = `commit-${++this.commitCounter}`; this.commits.set(sha, { tree, parents: [...parents] }); return sha; }
  private body(request: RequestUrlParam): unknown { return request.body ? JSON.parse(request.body) : undefined; }
  private response(status: number, json: unknown): RequestUrlResponse { return { status, json, text: JSON.stringify(json) }; }
}

class FakeVault {
  readonly configDir = ".obsidian"; readonly files = new Map<string, ArrayBuffer>(); private readonly explicitFolders = new Set<string>();
  readonly adapter = {
    list: async (directory: string) => this.list(directory), readBinary: async (path: string) => this.readBinary(path),
    writeBinary: async (path: string, data: ArrayBuffer) => this.writeBinary(path, data), exists: async (path: string) => this.exists(path),
    mkdir: async (path: string) => { this.explicitFolders.add(normalizePath(path)); }, remove: async (path: string) => { this.files.delete(normalizePath(path)); }
  };
  putText(path: string, text: string): void { this.files.set(normalizePath(path), arrayBufferFromText(text)); }
  readText(path: string): string | null { const data = this.files.get(normalizePath(path)); return data ? new TextDecoder().decode(data) : null; }
  getFileByPath(path: string): { path: string } | null { const normalized = normalizePath(path); return this.files.has(normalized) ? { path: normalized } : null; }
  async modifyBinary(file: { path: string }, data: ArrayBuffer): Promise<void> { this.files.set(file.path, copyArrayBuffer(data)); }
  async createBinary(path: string, data: ArrayBuffer): Promise<void> { this.files.set(normalizePath(path), copyArrayBuffer(data)); }
  async delete(file: { path: string }): Promise<void> { this.files.delete(file.path); }
  private async readBinary(path: string): Promise<ArrayBuffer> { const data = this.files.get(normalizePath(path)); if (!data) throw new Error(`Missing fake vault file: ${path}`); return copyArrayBuffer(data); }
  private async writeBinary(path: string, data: ArrayBuffer): Promise<void> { this.files.set(normalizePath(path), copyArrayBuffer(data)); }
  private async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path); if (this.files.has(normalized) || this.explicitFolders.has(normalized)) return true;
    const prefix = normalized ? `${normalized}/` : ""; return [...this.files.keys()].some((file) => file.startsWith(prefix));
  }
  private async list(directory: string): Promise<{ files: string[]; folders: string[] }> {
    const normalized = normalizePath(directory); const prefix = normalized ? `${normalized}/` : ""; const files = new Set<string>(); const folders = new Set<string>();
    for (const path of this.files.keys()) { if (!path.startsWith(prefix)) continue; const rest = path.slice(prefix.length); if (!rest) continue; const slash = rest.indexOf("/"); if (slash === -1) files.add(path); else folders.add(`${prefix}${rest.slice(0, slash)}`); }
    return { files: [...files].sort(), folders: [...folders].sort() };
  }
}

function makeBackend(server: FakeGitHub, vault: FakeVault): { backend: GitHubApiBackend; state: () => MobileSyncState } {
  let state = emptyMobileSyncState();
  const app = { vault, secretStorage: { getSecret: (name: string) => name === "github" ? "token" : null } };
  setRequestUrlHandler(server.handle);
  return {
    backend: new GitHubApiBackend(app as never, { owner: "test", name: "repo", branch: "main", remoteUrl: "https://github.com/test/repo.git" }, {
      tokenSecret: "github", state, saveState: async (next) => { state = next; }
    }), state: () => state
  };
}

beforeEach(() => setRequestUrlHandler(null)); afterEach(() => setRequestUrlHandler(null));

describe("GitHubApiBackend", () => {
  it("bootstraps a fresh mobile vault and then publishes a local edit", async () => {
    const server = new FakeGitHub(); await server.initialize({ "note.md": "remote v1\n" }); const vault = new FakeVault();
    vault.putText(".obsidian/plugins/vault-sync/data.json", "{\"local\":true}\n"); const { backend, state } = makeBackend(server, vault);
    const pulled = await backend.sync(); expect(pulled.message).toBe("Pulled remote changes."); expect(vault.readText("note.md")).toBe("remote v1\n");
    expect(vault.readText(".obsidian/plugins/vault-sync/data.json")).toContain("local"); expect(state().repository).toBe("test/repo");
    vault.putText("note.md", "mobile v2\n"); const pushed = await backend.sync(); expect(pushed.message).toBe("Pushed local changes.");
    expect(await server.readText("note.md")).toBe("mobile v2\n"); expect(state().baseCommit).toBe(server.head);
  });
  it("stops on a true same-file conflict without overwriting either side", async () => {
    const server = new FakeGitHub(); await server.initialize({ "note.md": "base\n" }); const vault = new FakeVault(); const { backend } = makeBackend(server, vault); await backend.sync();
    vault.putText("note.md", "local edit\n"); await server.directCommit({ "note.md": "remote edit\n" }); const result = await backend.sync();
    expect(result.status).toBe("conflict"); expect(vault.readText("note.md")).toBe("local edit\n"); expect(await server.readText("note.md")).toBe("remote edit\n");
  });
  it("merges different-path concurrent changes", async () => {
    const server = new FakeGitHub(); await server.initialize({ "base.md": "base\n" }); const vault = new FakeVault(); const { backend } = makeBackend(server, vault); await backend.sync();
    vault.putText("local.md", "from mobile\n"); await server.directCommit({ "remote.md": "from desktop\n" }); const result = await backend.sync();
    expect(result.message).toBe("Merged local and remote changes."); expect(await server.readText("local.md")).toBe("from mobile\n"); expect(vault.readText("remote.md")).toBe("from desktop\n");
  });
  it("retries safely when another writer moves main before the ref update", async () => {
    const server = new FakeGitHub(); await server.initialize({ "base.md": "base\n" }); const vault = new FakeVault(); const { backend } = makeBackend(server, vault); await backend.sync();
    vault.putText("local.md", "from mobile\n"); server.scheduleRace(2, { "race.md": "from llm\n" }); const result = await backend.sync();
    expect(result.message).toBe("Merged local and remote changes."); expect(await server.readText("local.md")).toBe("from mobile\n"); expect(vault.readText("race.md")).toBe("from llm\n");
  });
});
