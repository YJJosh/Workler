# workler add

Create a workspace: clone the project, set up a branch, apply the rules.

```bash
workler add <name> [base] [--branch <branch>] [--checkout <ref>] [--force] [--dry-run]
```

## Behavior

1. Clones the main project into `.worktrees/<name>` (a fast local clone). If the main project has uncommitted changes, a warning is printed — only committed work comes along.
2. Sets up the branch (see below).
3. Configures the workspace: `workler.root`/`workler.name` git config, all `origin` fetch/separate push URLs inherited from the project (relative local URLs are made absolute; `origin` is removed entirely when the project has none), the root's actual origin-ref snapshot instead of local-clone synthetic refs, a `workler-root` remote back to the parent, and `.worktrees/` excluded in the clone.
4. Applies the parent's optional [copy/link rules](/reference/configuration) when `.workler` is present.

The workspace/branch names and every rule are validated **before** the clone, so invalid names, malformed rules, and existing source symlink-ancestor traversal fail immediately without leaving a half-built clone behind.

If setup fails after cloning, the clone is left at `.worktrees/<name>` for inspection — remove it with `workler remove <name> --force`.

## Branch behavior

| Invocation | Result |
| --- | --- |
| `workler add feat` | **New** branch `feat` from the main project's current `HEAD`, checked out. Fails if `feat` already exists. |
| `workler add feat main` | **New** branch `feat` starting at `main`. `[base]` may be a local branch, remote branch (e.g. `origin/main`), tag, or commit. A remote-branch base also sets upstream tracking. |
| `workler add exp --branch feat/x` | Workspace `exp` on branch `feat/x` — created from `HEAD` if missing, checked out if it exists. |
| `workler add exp main --branch feat/x` | **New** branch `feat/x` starting at `main`, while keeping the filesystem-safe workspace name `exp`. |
| `workler add hotfix --checkout main` | No new branch: checks out `main` at the root's exact resolved tip, with upstream only when the real origin snapshot has it. Tags, commits, `HEAD`, and `@` land on a detached `HEAD`. The supported way to put several workspaces on one branch. |

`--checkout` cannot be combined with `--branch` or `[base]`. `[base]` may be combined with `--branch` to create that explicitly named branch from the base.

## Options

| Flag | Description |
| --- | --- |
| `--branch <branch>` | Use this branch name instead of the workspace name; create from `HEAD`, or from positional `[base]` when supplied |
| `--checkout <ref>` | Check out an existing branch/tag/commit; never creates a branch |
| `--force` | Replace rule destinations that already exist and differ |
| `--dry-run` | Print the whole plan (clone, branch, rules) without creating anything |

## Output

```text
cloning /path/to/project
     to /path/to/project/.worktrees/feature-a
create branch feature-a from HEAD
linked node_modules
copied .env
done   feature-a
path   /path/to/project/.worktrees/feature-a
```

Rule lines use the same status words as [`workler apply`](/reference/cli/apply): `ok`, `linked`, `copied`, `skip`, `would`, `conflict`.

## Errors

- Workspace `<name>` already exists, or the name is invalid (`main`, path separators, only dots).
- Branch `<name>` already exists (for the create-a-branch forms) — use `--checkout <name>` instead.
- The `[base]`/`--branch`/`--checkout` ref does not exist.
- A rule destination conflicts (see [Safety](/guide/safety)) — re-run `workler apply <name> --force` after resolving.

## Examples

```bash
workler add feature-a                      # new branch feature-a from HEAD
workler add hotfix v1.2.0                  # new branch hotfix from tag
workler add exp origin/main                # new branch exp tracking origin/main
workler add review --checkout main         # second checkout of main
workler add spike --branch feat/spike      # workspace and branch named differently
workler add spike main --branch feat/spike # explicit branch from an explicit base
workler add big-change --dry-run           # just show the plan
```
