# Vault Sync

Vault Sync is an Obsidian extension that uses GitHub as the synchronization hub for knowledge bases shared by PCs, phones, and LLMs with GitHub access.

```text
PC Obsidian <-> GitHub main <-> Mobile Obsidian
                         ^
                         |
                    LLM / Agent
                    via GitHub
```

## Core model

- One GitHub repository maps to one Obsidian vault.
- `main` is the single synchronized branch.
- Git is an implementation detail; normal use must not require Git commands.
- GitHub is both the remote history and the access layer for external LLMs/agents.
- Different-file concurrent edits merge automatically.
- True same-file conflicts pause synchronization and are resolved inside Obsidian by choosing the complete version from **This device** or **GitHub** for each conflicted file.
- Deletions synchronize normally and remain recoverable through Git history.

## Cross-device Obsidian settings

The vault configuration directory is synchronized in general, but device-local plugin state is protected. Vault Sync excludes the installed plugin directory, the community-plugin enablement list, workspace layout files, `.git/`, and Obsidian's local `.trash/` by default. Desktop also maintains these paths in `.git/info/exclude`, so they stay both untracked and out of normal Git status output.

## Architecture

Desktop uses the system Git executable behind a product-facing adapter. Mobile uses GitHub's HTTP APIs and stores the last synchronized Git snapshot so it can distinguish local-only changes, remote-only changes, safe different-file merges, and true same-file conflicts.

Desktop supports both directions of first repository initialization safely:

- an existing `main` may materialize only into a filesystem-safe fresh vault;
- an empty GitHub repository may be initialized from an existing vault without publishing protected device-local state.

See [docs/architecture.md](docs/architecture.md) and [docs/sync-protocol.md](docs/sync-protocol.md).

## Verification

The public snapshot includes deterministic tests for the three-way mobile merge planner, including local-only edits, remote-only edits, different-path merges, identical concurrent edits, delete propagation, and same-path conflicts. The source also exposes the desktop Git transport, mobile GitHub Git Database API transport, protected-path policy, and in-app conflict resolution for direct review.

## Development

```bash
npm install
npm run check
```

## License

Source-visible, all rights reserved. See [LICENSE](LICENSE).
