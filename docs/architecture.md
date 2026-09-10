# Architecture

## Product invariant

One configured GitHub repository maps to one Obsidian vault. The synchronized branch is `main`.

```text
PC Obsidian  <---->  GitHub main  <---->  Mobile Obsidian
                         ^
                         |
                    LLM / Agent
                    via GitHub MCP
```

GitHub is the synchronization hub and shared history. LLMs do not need to know about Obsidian; from Vault Sync's point of view, an LLM edit is simply a new remote commit on `main`.

## Platform split

The UI and synchronization policy are shared, while repository transport is platform-specific.

```text
Obsidian UI / events
        |
    SyncEngine
        |
   SyncBackend
   /         \
Desktop     Mobile
system git  GitHub API
```

Desktop dynamically loads Node.js only after verifying that Obsidian is running on desktop. Mobile must never import Node.js or Electron APIs at module load time. The build must therefore externalize both bare Node built-ins (for example `child_process`) and `node:`-prefixed built-ins (for example `node:child_process`) instead of switching the whole bundle to a Node-only platform.

### Desktop bootstrap

If the current desktop vault is not already a Git working tree, Vault Sync may bootstrap it only when the filesystem contains no user content outside Obsidian's own configuration/trash directories. The check is performed against the real filesystem rather than only `Vault.getFiles()`, so hidden user files cannot be overwritten accidentally.

It initializes `main`, binds `origin`, fetches the configured repository, validates that remote `main` does not track device-local protected paths, and then materializes `origin/main`. A non-empty existing vault is never overwritten automatically.

Desktop commits use a repository-local fallback Git identity when the user has no Git identity configured. A GitHub token selected through SecretStorage is injected into Git commands ephemerally; it is never written to `.git/config`. If no token is selected, system Git credential helpers remain available as a fallback.

### Mobile reconciliation

Mobile cannot rely on a local Git executable, so it persists a compact synchronization base containing the last synchronized commit and a mapping from repository path to Git blob SHA.

On each sync, Vault Sync compares three snapshots:

- base: the last synchronized blob map;
- local: the current mobile vault, hashed using Git blob identity rules;
- remote: the current `main` Git tree from GitHub.

Different-path changes are merged automatically. If both local and remote changed the same path to different blob identities, automatic synchronization stops with a conflict. Identical concurrent edits are accepted. Delete-vs-edit is a conflict; a deletion on one side propagates automatically only when the other side stayed at the base version.

Before updating `main`, Mobile rechecks the remote HEAD and uses a non-force ref update. If another device or LLM moved `main`, the attempt is discarded and synchronization is recalculated from the new remote state.

After a remote merge is published successfully, Mobile applies the resulting tree to the local vault path-by-path and then records the new synchronization base. This local application is **not a filesystem-wide atomic transaction**. If a local write/delete fails partway through, some paths may already reflect the published remote tree while later paths do not. The operation surfaces an error and does not advance the saved synchronization base; the next sync therefore recalculates against the still-authoritative remote commit. The implementation does not claim rollback of already-applied local path changes.

A fresh mobile vault with no synchronization base may contain Obsidian-generated configuration files. If it contains no user content outside the configuration directory, the first synchronization treats GitHub `main` as authoritative instead of misclassifying those generated files as user edits.

## Vault lifecycle boundary

The synchronization engine is a per-vault Obsidian plugin, but the desired product onboarding is repository-first: selecting `owner/repository` should create a vault named `repository` and open it.

That lifecycle cannot be implemented honestly by pretending the current Obsidian plugin API has capabilities it does not expose. Community plugins are installed per vault, Obsidian does not currently expose a supported plugin API/CLI for registering an arbitrary new folder as a vault, and Community-directory policy forbids a plugin from self-installing or self-updating into another vault.

Therefore repository-to-new-vault lifecycle is a separate product boundary from the per-vault sync engine. A zero-manual-setup implementation requires a supported Obsidian lifecycle API in the future or an external companion/launcher that owns vault creation/registration. The sync plugin must not mutate undocumented global Obsidian registry files or self-copy into another vault merely to simulate a supported API.

## Distribution

CI must run tests and a production build on every `main` push. Release artifacts must be rebuilt from source and never copied from an unverified workstation.

## Obsidian configuration policy

The Obsidian configuration directory itself is generally synchronized, but device-local state is protected by default.

Local-only paths:

- `.git/**`
- `.trash/**`
- `<configDir>/plugins/**`
- `<configDir>/community-plugins.json`
- `<configDir>/workspace.json`
- `<configDir>/workspace-mobile.json`

Never hard-code `.obsidian`; use `Vault.configDir`.

## Safety rules

1. Never resolve a semantic Git conflict by silently choosing ours or theirs.
2. Never force-push during normal synchronization.
3. Remote HEAD must be rechecked before updating `main`.
4. Deletions are normal synchronized changes and remain recoverable from Git history.
5. Synchronization failures must be surfaced. Mobile local-apply failures may leave a partially applied working copy, but they must not advance the synchronization base or be represented as an atomic rollback.
6. Device-local protected paths must be untracked on both local and remote before automatic synchronization proceeds.
7. Credentials are referenced through Obsidian SecretStorage; raw access tokens must not be persisted in normal plugin data or Git configuration.
8. Bootstrap safety checks must inspect the real filesystem, including hidden entries.
