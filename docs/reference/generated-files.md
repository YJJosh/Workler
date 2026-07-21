# Generated files

What Workler creates and configures, and where.

## In the main project

| Path | Created by | Purpose |
| --- | --- | --- |
| `.workler` | `workler init` or you | Optional [copy/link rules](/reference/configuration). Commit it when used. |
| `.worktrees/` | `workler init` / `workler add` | One subdirectory per workspace. Never commit it. |
| `.git/info/exclude` | `workler init` / `workler add` | Gets a `.worktrees/` line so workspaces stay invisible to git without touching your committed `.gitignore`. (Outside a git repo, `init` falls back to `.gitignore`.) |
| `refs/workler/<workspace>/<branch>` | `workler branch-sync` | Read-only mirrors of each workspace's local branches. Inspect with `git for-each-ref refs/workler/`; pruned automatically when a workspace is removed. |

### Git config keys (main project)

| Key | Value |
| --- | --- |
| `workler.root` | The project's own path (marks it as a workler root). |
| `workler.name` | `main`. |

## In each workspace

Each workspace under `.worktrees/<name>` is a normal clone, plus:

| What | Value / purpose |
| --- | --- |
| `git config workler.root` | Path of the immediate parent project — how discovery and [nested workspaces](/guide/nested-workspaces) find their way up. |
| `git config workler.name` | The workspace name. |
| Remote `origin` | Inherits the main project's fetch URL(s), separate push URL(s), and actual remote-tracking snapshot; relative local URLs are made absolute so they retain their meaning. Synthetic refs created by the local clone are removed. (No `origin` in the main project → none here.) |
| Remote `workler-root` | Points at the parent project's path; used by [`workler branch-sync`](/reference/cli/branch-sync). Recreated/fixed on every `branch-sync`. |
| `.git/info/exclude` | Gets a `.worktrees/` line, so the workspace can host nested workspaces. |
| Rule outputs | Symlinks from `link` rules and files/folders from `copy` rules. They do not count as dirty for tracked-only `status`/`sync`, but `remove` treats untracked and ignored outputs as local data and refuses without `--force`. |

## What to commit, what to ignore

- **If you use `.workler`, commit it.** It documents what a working checkout needs, and nested workspaces read the committed copy.
- **Nothing else needs ignoring by hand.** `.worktrees/` is excluded via `.git/info/exclude`, which is local to your machine — teammates who don't use Workler see no trace of it.
