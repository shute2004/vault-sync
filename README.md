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

Automated tests cover:

- three-way mobile merge planning;
- Desktop bootstrap against real temporary Git repositories;
- Desktop push/pull and protected local-only paths;
- Desktop same-file conflict capture and both resolution choices;
- Mobile synchronization through a simulated GitHub Git Database API;
- same-file conflict preservation;
- different-path concurrent merges;
- remote-HEAD movement and retry;
- both local and GitHub conflict choices on Mobile.

GitHub Actions runs `npm run check`, which executes the Vitest suite and a production build, then uploads the built Obsidian plugin files as a workflow artifact.

## Development

```bash
npm install
npm run check
```

## License

Source-visible, all rights reserved. See [LICENSE](LICENSE).
