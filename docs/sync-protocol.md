# Sync protocol

## State model

Each vault tracks a last successfully synchronized commit (`base`). At sync time there are three relevant states:

- `base`: last synchronized commit
- `local`: current vault state
- `remote`: current GitHub `main`

## Reconciliation

| Local changed | Remote changed | Action |
| --- | --- | --- |
| No | No | No-op |
| No | Yes | Apply remote |
| Yes | No | Commit and push local |
| Yes | Yes | Three-way reconcile from `base` |

When both sides changed, automatic integration is allowed only if it is conflict-free. A conflict pauses synchronization and requires user resolution.

Before any push, Vault Sync checks the current remote HEAD again. If it has moved, the operation is retried against the new remote state rather than overwriting it.

## Trigger model

Synchronization is intentionally not real-time.

- on vault startup after layout ready
- after a local-change debounce window
- periodic remote checks while Obsidian is open
- manual `Sync now`

The initial defaults are 60 seconds for local debounce and 5 minutes for remote polling.
