import { afterEach, describe, expect, it } from "vitest";
import {
  normalizePath,
  setRequestUrlHandler,
  type RequestUrlParam,
  type RequestUrlResponse
} from "../../test/obsidian-runtime";
import { emptyMobileSyncState, type MobileSyncState } from "../sync/types";
import { GitHubApiBackend } from "./github-api";

function buffer(text: string): ArrayBuffer { return new TextEncoder().encode(text).buffer; }
function cloneBuffer(data: ArrayBuffer): ArrayBuffer { return new Uint8Array(data).slice().buffer; }
async function blobSha(data: ArrayBuffer): Promise<string> {
  const header = new TextEncoder().encode(`blob ${data.byteLength}\0`);
  const input = new Uint8Array(header.byteLength + data.byteLength);
  input.set(header); input.set(new Uint8Array(data), header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

class OneFileGitHub {
  private readonly blobs = new Map<string, ArrayBuffer>();
  private readonly trees = new Map<string, Record<string, string>>();
  private readonly commits = new Map<string, { tree: string; parent?: string }>();
  private sequence = 0;
  head = "";

  async initialize(text: string): Promise<void> { await this.directEdit(text); }
  async directEdit(text: string): Promise<void> {
    const data = buffer(text); const sha = await blobSha(data); this.blobs.set(sha, data);
    const tree = `tree-${++this.sequence}`; this.trees.set(tree, { "note.md": sha });
    const commit = `commit-${++this.sequence}`; this.commits.set(commit, { tree, parent: this.head || undefined }); this.head = commit;
  }
  async text(): Promise<string> {
    const commit = this.commits.get(this.head); const sha = commit ? this.trees.get(commit.tree)?.["note.md"] : undefined;
    const data = sha ? this.blobs.get(sha) : undefined; return data ? new TextDecoder().decode(data) : "";
  }
  handle = async (request: RequestUrlParam): Promise<RequestUrlResponse> => {
    const url = new URL(request.url); const path = `${url.pathname.replace("/repos/test/repo", "")}${url.search}`; const method = request.method ?? "GET";
    if (method === "GET" && path === "/git/ref/heads/main") return response(200, { object: { sha: this.head } });
    const commitMatch = path.match(/^\/git\/commits\/(.+)$/);
    if (method === "GET" && commitMatch) { const sha = commitMatch[1] ?? ""; const commit = this.commits.get(sha); return commit ? response(200, { sha, tree: { sha: commit.tree } }) : response(404, {}); }
    const treeMatch = path.match(/^\/git\/trees\/(.+)\?recursive=1$/);
    if (method === "GET" && treeMatch) { const sha = treeMatch[1] ?? ""; const tree = this.trees.get(sha) ?? {}; return response(200, { sha, truncated: false, tree: Object.entries(tree).map(([entryPath, entrySha]) => ({ path: entryPath, mode: "100644", type: "blob", sha: entrySha })) }); }
    const blobMatch = path.match(/^\/git\/blobs\/(.+)$/);
    if (method === "GET" && blobMatch) { const sha = blobMatch[1] ?? ""; const data = this.blobs.get(sha); return data ? response(200, { sha, encoding: "base64", content: Buffer.from(new Uint8Array(data)).toString("base64") }) : response(404, {}); }
    if (method === "POST" && path === "/git/blobs") {
      const body = JSON.parse(request.body ?? "{}") as { content: string }; const data = Uint8Array.from(Buffer.from(body.content, "base64")).buffer;
      const sha = await blobSha(data); this.blobs.set(sha, data); return response(201, { sha });
    }
    if (method === "POST" && path === "/git/trees") {
      const body = JSON.parse(request.body ?? "{}") as { base_tree: string; tree: Array<{ path: string; sha: string | null }> };
      const next = { ...(this.trees.get(body.base_tree) ?? {}) };
      for (const entry of body.tree) { if (entry.sha === null) delete next[entry.path]; else next[entry.path] = entry.sha; }
      const sha = `tree-${++this.sequence}`; this.trees.set(sha, next); return response(201, { sha });
    }
    if (method === "POST" && path === "/git/commits") {
      const body = JSON.parse(request.body ?? "{}") as { tree: string; parents: string[] }; const sha = `commit-${++this.sequence}`;
      this.commits.set(sha, { tree: body.tree, parent: body.parents[0] }); return response(201, { sha });
    }
    if (method === "PATCH" && path === "/git/refs/heads/main") {
      const body = JSON.parse(request.body ?? "{}") as { sha: string; force: boolean }; const commit = this.commits.get(body.sha);
      if (body.force || !commit || commit.parent !== this.head) return response(422, { message: "non-fast-forward" });
      this.head = body.sha; return response(200, { object: { sha: this.head } });
    }
    return response(404, { method, path });
  };
}

class TinyVault {
  readonly configDir = ".obsidian";
  private readonly files = new Map<string, ArrayBuffer>();
  readonly adapter = {
    list: async (directory: string) => {
      const normalized = normalizePath(directory); const prefix = normalized ? `${normalized}/` : "";
      return { files: [...this.files.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/")), folders: [] };
    },
    readBinary: async (path: string) => cloneBuffer(this.require(path)),
    writeBinary: async (path: string, data: ArrayBuffer) => { this.files.set(normalizePath(path), cloneBuffer(data)); },
    exists: async (path: string) => this.files.has(normalizePath(path)),
    mkdir: async () => undefined,
    remove: async (path: string) => { this.files.delete(normalizePath(path)); }
  };
  put(text: string): void { this.files.set("note.md", buffer(text)); }
  text(): string { return new TextDecoder().decode(this.require("note.md")); }
  getFileByPath(path: string): { path: string } | null { const normalized = normalizePath(path); return this.files.has(normalized) ? { path: normalized } : null; }
  async modifyBinary(file: { path: string }, data: ArrayBuffer): Promise<void> { this.files.set(file.path, cloneBuffer(data)); }
  async createBinary(path: string, data: ArrayBuffer): Promise<void> { this.files.set(normalizePath(path), cloneBuffer(data)); }
  async delete(file: { path: string }): Promise<void> { this.files.delete(file.path); }
  private require(path: string): ArrayBuffer { const data = this.files.get(normalizePath(path)); if (!data) throw new Error(`Missing ${path}`); return data; }
}

function response(status: number, json: unknown): RequestUrlResponse { return { status, json, text: JSON.stringify(json) }; }
function backend(server: OneFileGitHub, vault: TinyVault): GitHubApiBackend {
  let state: MobileSyncState = emptyMobileSyncState(); setRequestUrlHandler(server.handle);
  return new GitHubApiBackend({ vault, secretStorage: { getSecret: () => "token" } } as never,
    { owner: "test", name: "repo", branch: "main", remoteUrl: "https://github.com/test/repo.git" },
    { tokenSecret: "github", state, saveState: async (next) => { state = next; } });
}

afterEach(() => setRequestUrlHandler(null));

describe("GitHubApiBackend conflict resolution", () => {
  it("keeps the current mobile version when the user selects This device", async () => {
    const server = new OneFileGitHub(); await server.initialize("base\n"); const vault = new TinyVault(); const sync = backend(server, vault); await sync.sync();
    vault.put("local\n"); await server.directEdit("remote\n"); const conflict = await sync.sync();
    expect(conflict.status).toBe("conflict"); expect(sync.getConflictPaths()).toEqual(["note.md"]);
    const result = await sync.resolveConflicts({ "note.md": "local" });
    expect(result.status).toBe("idle"); expect(result.message).toBe("Resolved conflicts and synchronized."); expect(vault.text()).toBe("local\n"); expect(await server.text()).toBe("local\n");
  });
  it("applies GitHub's version locally when the user selects GitHub", async () => {
    const server = new OneFileGitHub(); await server.initialize("base\n"); const vault = new TinyVault(); const sync = backend(server, vault); await sync.sync();
    vault.put("local\n"); await server.directEdit("remote\n"); await sync.sync(); const result = await sync.resolveConflicts({ "note.md": "remote" });
    expect(result.status).toBe("idle"); expect(vault.text()).toBe("remote\n"); expect(await server.text()).toBe("remote\n");
  });
});
