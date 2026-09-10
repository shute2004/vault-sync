import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemAdapter as MockFileSystemAdapter } from "../../test/obsidian-runtime";
import { DesktopSystemGitBackend } from "./desktop-system-git";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vault-sync-desktop-test-"));
  tempRoots.push(root);
  return root;
}

async function makeEmptyRemote(root: string): Promise<string> {
  const remote = join(root, "remote.git");
  await git(["init", "--bare", remote]);
  return remote;
}

async function seedRemote(root: string): Promise<{ remote: string; seed: string }> {
  const remote = await makeEmptyRemote(root);
  const seed = join(root, "seed");
  await git(["init", "-b", "main", seed]);
  await git(["config", "user.name", "Test"], seed);
  await git(["config", "user.email", "test@example.com"], seed);
  await writeFile(join(seed, "note.md"), "remote v1\n");
  await git(["add", "note.md"], seed);
  await git(["commit", "-m", "seed"], seed);
  await git(["remote", "add", "origin", remote], seed);
  await git(["push", "-u", "origin", "main"], seed);
  return { remote, seed };
}

function makeBackend(vaultRoot: string, remote: string): DesktopSystemGitBackend {
  const app = {
    vault: {
      adapter: new MockFileSystemAdapter(vaultRoot),
      configDir: ".obsidian"
    },
    secretStorage: {
      getSecret: () => null
    }
  };

  return new DesktopSystemGitBackend(app as never, {
    owner: "test",
    name: "remote",
    branch: "main",
    remoteUrl: remote
  });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DesktopSystemGitBackend", () => {
  it("bootstraps a fresh vault, preserves local-only plugin state, pushes, and pulls", async () => {
    const root = await makeTempRoot();
    const { remote, seed } = await seedRemote(root);
    const vault = join(root, "vault");
    const pluginDir = join(vault, ".obsidian", "plugins", "vault-sync");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "data.json"), "{\"local\":true}\n");

    const backend = makeBackend(vault, remote);
    await backend.ensureReady();

    expect(await readFile(join(vault, "note.md"), "utf8")).toBe("remote v1\n");
    expect(await readFile(join(pluginDir, "data.json"), "utf8")).toContain("local");
    expect(await git(["ls-files", ".obsidian/plugins"], vault)).toBe("");
    expect(await git(["config", "--local", "user.name"], vault)).toBe("Vault Sync");

    await writeFile(join(vault, "note.md"), "desktop v2\n");
    const pushed = await backend.sync();
    expect(pushed.message).toBe("Pushed local changes.");
    expect(await git([`--git-dir=${remote}`, "show", "main:note.md"])).toBe("desktop v2");

    await git(["fetch", "origin", "main"], seed);
    await git(["reset", "--hard", "origin/main"], seed);
    await writeFile(join(seed, "note.md"), "remote v3\n");
    await git(["add", "note.md"], seed);
    await git(["commit", "-m", "remote update"], seed);
    await git(["push", "origin", "main"], seed);

    const pulled = await backend.sync();
    expect(pulled.message).toBe("Pulled remote changes.");
    expect(await readFile(join(vault, "note.md"), "utf8")).toBe("remote v3\n");
  });

  it("initializes an empty remote from an existing vault without publishing local-only plugin state", async () => {
    const root = await makeTempRoot();
    const remote = await makeEmptyRemote(root);
    const vault = join(root, "vault");
    const pluginDir = join(vault, ".obsidian", "plugins", "vault-sync");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(vault, "existing.md"), "existing knowledge\n");
    await writeFile(join(pluginDir, "data.json"), "{\"secretName\":\"github\"}\n");

    const backend = makeBackend(vault, remote);
    await backend.ensureReady();

    expect(await git([`--git-dir=${remote}`, "show", "main:existing.md"])).toBe("existing knowledge");
    expect(await git([`--git-dir=${remote}`, "ls-tree", "-r", "--name-only", "main", "--", ".obsidian/plugins"])).toBe("");
    expect(await readFile(join(pluginDir, "data.json"), "utf8")).toContain("secretName");
    expect(await git(["status", "--porcelain"], vault)).toBe("");
  });

  it("refuses bootstrap when hidden filesystem content exists outside allowed Obsidian state and remote main already exists", async () => {
    const root = await makeTempRoot();
    const { remote } = await seedRemote(root);
    const vault = join(root, "vault");
    await mkdir(join(vault, ".obsidian"), { recursive: true });
    await mkdir(join(vault, ".private"), { recursive: true });
    await writeFile(join(vault, ".private", "keep.txt"), "keep\n");

    const backend = makeBackend(vault, remote);
    await expect(backend.ensureReady()).rejects.toThrow("existing filesystem content");
    await expect(readFile(join(vault, ".private", "keep.txt"), "utf8")).resolves.toBe("keep\n");
  });
});
