# Workspaces & branches

A workspace is a normal local clone of your project, living under `.worktrees/<name>`. Because it is a real clone — not a `git worktree` — it has its own `HEAD`, its own index, its own local branches, and its own fetch state. The main project itself appears in listings as the reserved workspace `main`.

## Creating workspaces

```bash
workler add <name> [base] [--branch <branch>] [--checkout <ref>] [--force] [--dry-run]
```

`add` clones the main project into `.worktrees/<name>` (a fast local clone), sets up the branch you asked for, and applies the [copy/link rules](/guide/rules).

### Branch behavior

| Command | Result |
| --- | --- |
| `workler add feat` | Creates a **new** branch `feat` from the main project's current `HEAD` and checks it out. |
| `workler add feat main` | Creates a **new** branch `feat` starting at `main`. The base may be a local branch, a remote branch (e.g. `origin/main`), a tag, or a commit. A remote-branch base also sets upstream tracking. |
| `workler add exp --branch feat/x` | Workspace named `exp`, branch named `feat/x`. Creates `feat/x` from `HEAD` if it does not exist, otherwise checks it out. |
| `workler add exp main --branch feat/x` | Creates branch `feat/x` from `main`, while the workspace remains named `exp`. |
| `workler add hotfix --checkout main` | No new branch: checks out `main` at the root's resolved tip. Tags, commits, `HEAD`, and `@` are checked out on a detached `HEAD`. |

Rules:

- `--checkout` cannot be combined with `--branch` or positional `[base]`. `[base]` may be combined with `--branch` to create that explicitly named branch from the base.
- `workler add <name>` / `workler add <name> <base>` always create a new branch and **fail if branch `<name>` already exists** — use `--checkout <name>` to reuse the existing branch.
- Workspace names cannot be `main`, contain path separators/control characters, be made only of dots, exceed a portable filesystem component, or contain characters that cannot appear in the `refs/workler/<workspace>/...` namespace used by `branch-sync`. Windows-reserved device names are rejected on every platform.

### Several workspaces on one branch

`git worktree` refuses to check out the same branch twice. Workler workspaces are independent clones, so this just works:

```bash
workler add review-1 --checkout main
workler add review-2 --checkout main
```

Both workspaces sit on `main`, each with its own working tree and index.

### What `add` sets up

Beyond the clone and branch, `add` configures the workspace so everything else works later:

- `git config workler.root` points at the main project, `workler.name` records the workspace name.
- `origin` inherits all of the main project's fetch URLs and any separate push URLs, so `git fetch`/`git push` behave as expected. Relative local URLs are made absolute before inheritance so moving two directory levels into `.worktrees/<name>` does not change what they point to. Its remote-tracking refs mirror the root's current real `origin` snapshot rather than the local clone's synthetic refs, so local-only branches have no fake upstream and ahead/behind is immediately accurate. **If the main project has no `origin`, the workspace gets none either** — a local clone would otherwise leave `origin` pointing at the main project on disk, and `git push origin` would push straight into it.
- A `workler-root` remote points back at the main project — used by [`workler branch-sync`](/reference/cli/branch-sync). Every workspace gets one, with or without an `origin`.
- `.worktrees/` is added to the clone's `.git/info/exclude`, so [nested workspaces](/guide/nested-workspaces) stay invisible to git.

::: tip Uncommitted changes don't come along
A clone only contains committed work. If the main project has uncommitted changes when you `add`, Workler prints a warning — commit or stash first if the new workspace needs those changes.
:::

## Listing and navigating

```bash
$ workler list
main       main       /path/to/project
feature-a  feature-a  /path/to/project/.worktrees/feature-a
review-1   main       /path/to/project/.worktrees/review-1
```

(`list` prints no header row; [`workler status`](/reference/cli/status) is the one with headers, upstream, and clean/dirty state.)

`workler path <name>` prints just the path, made for command substitution:

```bash
cd "$(workler path feature-a)"
```

or use the [`wcd` shell helper](/guide/shell-helper).

## Removing workspaces

```bash
workler remove feature-a
```

`remove` deletes the workspace directory — but refuses if the workspace has any local changes, untracked **and gitignored** files included: deletion is forever, so even a copied/ignored `.env` or nested `.worktrees/` counts here. Use `--force` to remove anyway. The `main` workspace can never be removed.

## Next steps

- [Copy & link rules](/guide/rules) — what gets set up inside each workspace.
- [Safety, `--force`, `--dry-run`](/guide/safety) — how conflicts are handled.
- [Keeping workspaces in sync](/guide/sync) — because independent clones drift.
