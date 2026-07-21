# workler remove

Delete a workspace.

```bash
workler remove <name> [--force]
```

## Behavior

Recursively deletes `.worktrees/<name>` — after checking that nothing would be lost:

- Refuses if the workspace has **any local changes** — uncommitted changes to tracked files, untracked files, and ignored files. Deletion is forever, so this guard is deliberately stricter than the tracked-only dirty check used by [`status`](/reference/cli/status) and [`sync`](/reference/cli/sync); even a gitignored `.env`, files created by [copy rules](/reference/configuration), and nested `.worktrees/` count.
- `main` can never be removed.

Removal is plain directory deletion: any nested workspaces under the workspace's own `.worktrees/` go with it, and local branches that exist only in that clone are lost — run [`workler branch-sync`](/reference/cli/branch-sync) first if you want them mirrored into the root as `refs/workler/<name>/...`.

## Options

| Flag | Description |
| --- | --- |
| `--force` | Remove even with local changes |

## Output

```text
removed feature-a
```

## Errors

- No workspace named `<name>`.
- Workspace has local changes (without `--force`): `workspace has local changes: <path>`.
- `<name>` is `main`.

## Examples

```bash
workler remove feature-a
workler remove broken-experiment --force
workler branch-sync && workler remove feature-a   # keep its branches as refs first
```
