# CLI overview

```bash
workler <command> [arguments] [flags]
```

Every command also accepts `-h`/`--help`. `workler help` prints a concise command overview; the command pages below provide the full reference.

## Workspace commands

| Command | What it does |
| --- | --- |
| [`workler init`](/reference/cli/init) | Optional helper: create a starter `.workler` and prepare local directories |
| [`workler add`](/reference/cli/add) | Clone a new workspace, set up its branch, apply rules, run setup commands |
| [`workler apply`](/reference/cli/apply) | (Re-)apply the copy/link rules to workspaces |
| [`workler setup`](/reference/cli/setup) | Re-run the `setup` commands in a workspace |
| [`workler list`](/reference/cli/list) | Show every workspace with branch and path |
| [`workler path`](/reference/cli/path) | Print one workspace's path (for `cd "$(...)"`), or one member of a group workspace |
| [`workler remove`](/reference/cli/remove) | Delete a workspace |

## Multi-workspace commands

These operate on the main project **and every workspace** at once:

| Command | What it does |
| --- | --- |
| [`workler status`](/reference/cli/status) | Branch, upstream ahead/behind, clean/dirty per workspace |
| [`workler fetch`](/reference/cli/fetch) | `git fetch --prune origin` everywhere |
| [`workler sync`](/reference/cli/sync) | Fetch, then fast-forward-only update of each current branch |
| [`workler branch-sync`](/reference/cli/branch-sync) | Sync local branches root ↔ workspaces |

## Helpers

| Command | What it does |
| --- | --- |
| [`workler shell-init`](/reference/cli/shell-init) | Print the `wcd` shell function |
| `workler help` | Print the command overview and documentation link |
| `workler --version` | Print the version and exit (also `-v`, `workler version`) |

`--version` prints the bare version on one line (`0.2.0`), the way `npm --version` does, so it can be read by a script without stripping a prefix.

## Shared flags

| Flag | On | Meaning |
| --- | --- | --- |
| `--dry-run` | `add`, `apply` | Print what would be copied/linked/replaced without changing anything |
| `--copy-links` | `add`, `apply` | Apply `link` rules as independent copies; on `apply`, converts existing symlinks (`--no-copy-links` reverts) |
| `--force` | `add`, `apply` | Replace destinations that already exist and differ |
| `--force` | `remove` | Remove even with uncommitted changes |
| `--no-setup` | `add` | Skip the `setup` commands (`workler setup <name>` runs them later) |

Flags take values as `--flag value` or `--flag=value`. Errors go to stderr and exit with a non-zero status, prefixed `workler:`.

## Where commands run

Every command operates on the **nearest enclosing Git repository**. No initialization or `.workler` file is required. Managed workspaces carry repository-local `workler.*` Git configuration so a [nested workspace](/guide/nested-workspaces) remains its own project rather than resolving to the outermost root; bare `apply` and `setup` inside a workspace target that workspace from its parent. The one recovery exception is an unmarked **independent clone** directly under a parent's `.worktrees/`: Workler treats it as a partial workspace belonging to that parent so it can still be listed or removed after failed setup. Linked `git worktree` checkouts use a `.git` file rather than a directory and remain separate projects. Outside Git, a `.workler` created by `workler init` can act as an explicit project marker.

A plain folder whose `.workler` has `project <path>` lines is a [project group](/guide/project-groups) and is the project for every command run in it or in a plain subfolder of it, even when some unrelated outer repository encloses the folder. Inside one of the listed repositories, that repository is the project, as always. In group commands, `<name>/<project path>` addresses one member of a workspace (`feat/projects/api`) and `main/<project path>` a source repository.
