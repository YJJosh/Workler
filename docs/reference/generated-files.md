# Generated files

What Workler creates and configures, and where.

## In the main project

| Path | Created by | Purpose |
| --- | --- | --- |
| `.workler` | `workler init` or you | Optional [copy/link rules](/reference/configuration). Commit it when used. |
| `.worktrees/` | `workler init` / `workler add` | One subdirectory per workspace. Never commit it. |
| `.git/info/exclude` | `workler init` / `workler add` | Gets a `.worktrees/` line so workspaces stay invisible to git without touching your committed `.gitignore`. (Outside a git repo, `init` falls back to `.gitignore`.) |
| `refs/workler/<workspace>/<branch>` | `workler branch-sync` | Read-only mirrors of each workspace's local branches. Inspect with `git for-each-ref refs/workler/`; pruned automatically when a workspace is removed. |
| `refs/workler-group/<group>/<workspace>/<branch>` | `workler branch-sync` run at a [group root](/guide/project-groups) | Read-only mirrors of the branches of this repository's clone inside a group workspace. `<group>` is the group folder's name plus a short hash of its path. A separate namespace per group, so a group workspace and one of the repository's own workspaces may share a name, and a repository that belongs to two groups keeps their mirrors apart. |

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
| `git config workler.copyLinks` | `true` only after `--copy-links`: `apply` keeps materializing `link` rules as [copies](/guide/rules#copying-instead-of-linking) in this workspace. |
| Remote `origin` | Inherits the main project's fetch URL(s), separate push URL(s), and actual remote-tracking snapshot; relative local URLs are made absolute so they retain their meaning. Synthetic refs created by the local clone are removed. (No `origin` in the main project → none here.) |
| Remote `workler-root` | Points at the parent project's path; used by [`workler branch-sync`](/reference/cli/branch-sync). Recreated/fixed on every `branch-sync`. |
| `.git/info/exclude` | Gets a `.worktrees/` line, so the workspace can host nested workspaces. |
| Rule outputs | Symlinks from `link` rules and files/folders from `copy` rules. They do not count as dirty for tracked-only `status`/`sync`, but `remove` treats untracked and ignored outputs as local data and refuses without `--force`. |

## In a project group

A [project group](/guide/project-groups) root is a plain folder, so there is no Git config to record anything in; the files do the work.

| Path | Created by | Purpose |
| --- | --- | --- |
| `.workler` | `workler init` or you | `project <path>` lines naming the repositories below, plus optional group-level copy/link rules. |
| `.worktrees/` | `workler init` / `workler add` | One subdirectory per group workspace. |
| `.gitignore` | `workler init` | Gets a `.worktrees/` line (only matters if the folder sits inside some outer repository). |

Each group workspace under `.worktrees/<name>` is a plain directory holding:

| What | Value / purpose |
| --- | --- |
| `.workler` | A copy of the group's file, so the workspace is a group root of its own (nested group workspaces) and is recognized even before any member is cloned. `remove` treats the copy as harmless only while it still matches the group's file. |
| `<project path>/` | One clone per `project` line, in the same layout as the root. |
| Group rule outputs | Files and links from the group's own `copy`/`link` rules, next to the clones. They count as local data for `remove`. |

### Git config keys (member clone)

A member clone is a normal workspace of its source repository, so it has everything listed under [In each workspace](#in-each-workspace): `workler.root` is the **source repository** (`root/projects/api`), `workler.name` is the group workspace name, `workler-root` points at the source. Three keys are added:

| Key | Value |
| --- | --- |
| `workler.group` | The group root the clone belongs to. |
| `workler.groupProject` | The declared project path (`projects/api`), with forward slashes. |
| `workler.groupCopyLinks` | `true` only after `--copy-links`: the copy-links mode of the **group's own** rules, kept here because the group workspace folder is not a repository. Separate from `workler.copyLinks`, which is this clone's own mode. |

## What to commit, what to ignore

- **If you use `.workler`, commit it.** It documents what a working checkout needs, and nested workspaces read the committed copy.
- **Nothing else needs ignoring by hand.** `.worktrees/` is excluded via `.git/info/exclude`, which is local to your machine — teammates who don't use Workler see no trace of it.
