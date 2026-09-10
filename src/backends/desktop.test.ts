import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemAdapter as MockFileSystemAdapter } from "../../test/obsidian-runtime";
import { DesktopSyncBackend } from "./desktop";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vault-sync-conflict-test-"));
  tempRoots.push(root);
  return root;
}

async function setup(): Promise<{
  remote: string;
  seed: string;
  vault: string;
  backend: DesktopSyncBackend;
}> {
  const root = await tempRoot();
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const vault = join(root, "vault");
  await git(["init", "--bare", remote]);
  await git(["init", "-b", "main", seed]);
  await git(["config", "user.name", "Test"], seed);
  await git(["config", "user.email", "test@example.com"], seed);
  await writeFile(join(seed, "note.md"), "base\n");
  await git(["add", "note.md"], seed);
  await git(["commit", "-m", "base"], seed);
  await git(["remote", "add", "origin", remote], seed);
  await git(["push", "-u", "origin", "main"], seed);

  await mkdir(join(vault, ".obsidian", "plugins", "vault-sync"), { recursive: true });
  const app = {
    vault: {
      adapter: new MockFileSystemAdapter(vault),
      configDir: ".obsidian"
    },
    secretStorage: { getSecret: () => null }
  };
  const backend = new DesktopSyncBackend(app as never, {
    owner: "test",
    name: "remote",
    branch: "main",
    remoteUrl: remote
  });
  await backend.ensureReady();
  return { remote, seed, vault, backend };
}

async function createDivergence(seed: string, vault: string): Promise<void> {
  await writeFile(join(vault, "note.md"), "local\n");
  await git(["add", "note.md"], vault);
  await git(["commit", "-m", "local"], vault);

  await writeFile(join(seed, "note.md"), "remote\n");
  await git(["add", "note.md"], seed);
  await git(["commit", "-m", "remote"], seed);
  await git(["push", "origin", "main"], seed);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DesktopSyncBackend conflicts", () => {
  it("captures a conflict, aborts the rebase, and resolves with the local version", async () => {
    const { remote, seed, vault, backend } = await setup();
    await createDivergence(seed, vault);

    const conflict = await backend.sync();
    expect(conflict.status).toBe("conflict");
    expect(conflict.conflictPaths).toEqual(["note.md"]);
    expect(backend.getConflictPaths()).toEqual(["note.md"]);
    expect(await git(["diff", "--name-only", "--diff-filter=U"], vault)).toBe("");
    expect(await readFile(join(vault, "note.md"), "utf8")).toBe("local\n");

    const resolved = await backend.resolveConflicts({ "note.md": "local" });
    expect(resolved.status).toBe("idle");
    expect(resolved.message).toBe("Resolved conflicts and synchronized.");
    expect(await git([`--git-dir=${remote}`, "show", "main:note.md"])).toBe("local");
    expect(await git(["status", "--porcelain"], vault)).toBe("");
  });

  it("resolves with the GitHub version when selected", async () => {
    const { remote, seed, vault, backend } = await setup();
    await createDivergence(seed, vault);
    await backend.sync();

    const resolved = await backend.resolveConflicts({ "note.md": "remote" });
    expect(resolved.status).toBe("idle");
    expect(await readFile(join(vault, "note.md"), "utf8")).toBe("remote\n");
    expect(await git([`--git-dir=${remote}`, "show", "main:note.md"])).toBe("remote");
  });
});
