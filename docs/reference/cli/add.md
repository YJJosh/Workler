# workler add

Create a workspace: clone the project, set up a branch, apply the rules, run the setup commands.

```bash
workler add <name> [base] [--branch <branch>] [--checkout <ref>] [--copy-links] [--force] [--no-setup] [--dry-run]
```

## Behavior

1. Clones the main project into `.worktrees/<name>` (a fast local clone). If the main project has uncommitted changes, a warning is printed — only committed work comes along.
2. Sets up the branch (see below).
3. Configures the workspace: `workler.root`/`workler.name` git config, all `origin` fetch/separate push URLs inherited from the project (relative local URLs are made absolute; `origin` is removed entirely when the project has none), the root's actual origin-ref snapshot instead of local-clone synthetic refs, a `workler-root` remote back to the parent, and `.worktrees/` excluded in the clone.
4. Applies the parent's optional [copy/link rules](/reference/configuration) when `.workler` is present.
5. Runs the parent's optional [`setup` commands](/guide/setup) (`setup pnpm install`, ...) inside the finished workspace: sequentially, in file order, through the platform shell, with `WORKLER_WORKSPACE`, `WORKLER_WORKSPACE_PATH`, and `WORKLER_ROOT` in the environment and the caller's package-manager variables (`npm_*`, `pnpm_*`, `yarn_*`, `INIT_CWD`) left out. A `setup --if-missing <path>` line is skipped while that path exists in the workspace. The project lock is released before this step, so sibling workspaces can be added meanwhile.

The workspace/branch names and every rule and setup line are validated **before** the clone, so invalid names, malformed rules, and existing source symlink-ancestor traversal fail immediately without leaving a half-built clone behind.

If configuring the clone fails (a rule conflict, say), the clone is left at `.worktrees/<name>` for inspection — remove it with `workler remove <name> --force`.

If a setup command fails, the workspace is complete and is **kept**. `add` prints the command and its exit code, exits non-zero, and the remaining commands do not run; fix the cause and re-run them with [`workler setup <name>`](/reference/cli/setup).

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
| `--copy-links` | Copy what `link` rules would symlink, so the workspace shares nothing with the main project; remembered for later `apply` runs. See [Copying instead of linking](/guide/rules#copying-instead-of-linking) |
| `--force` | Replace rule destinations that already exist and differ |
| `--no-setup` | Skip the `setup` commands; run them later with `workler setup <name>` |
| `--dry-run` | Print the whole plan (clone, branch, rules, setup commands) without creating anything |

## Output

```text
cloning /path/to/project
     to /path/to/project/.worktrees/feature-a
create branch feature-a from HEAD
linked node_modules
copied .env
skip   setup pnpm install (node_modules exists)
setup  pnpm run codegen
...
done   feature-a
path   /path/to/project/.worktrees/feature-a
```

Rule lines use the same status words as [`workler apply`](/reference/cli/apply): `ok`, `linked`, `copied`, `skip`, `would`, `conflict`. Each setup command is announced with a `setup` heading and then prints whatever it prints; a guarded command whose `--if-missing` path exists gets a `skip` line instead; with no `setup` lines, nothing is announced. When stdout is not a terminal, the commands' stdout is routed to stderr, so a script reading the `path` line sees only Workler's own output. With `--dry-run`, commands are listed as `would  setup ...` (`... (only if <path> is missing)` for a guarded one).

## Errors

- Workspace `<name>` already exists, or the name is invalid (`main`, path separators, only dots).
- Branch `<name>` already exists (for the create-a-branch forms) — use `--checkout <name>` instead.
- The `[base]`/`--branch`/`--checkout` ref does not exist.
- A rule destination conflicts (see [Safety](/guide/safety)) — re-run `workler apply <name> --force` after resolving.
- A setup command exits non-zero — the workspace is kept; re-run `workler setup <name>` after fixing the cause.

## In a project group

Run in a [project group](/guide/project-groups) root, `add` creates `.worktrees/<name>/` holding one clone per `project` line, in the same layout as the root, with a copy of the group's `.workler` next to them. The branch options above apply to **every** member, and everything is validated for every member before anything is cloned: one member with the branch already, without the base ref, or whose declared path is missing, not a repository, or reached through a symbolic link (links are never followed), fails the whole command and leaves nothing behind. Each clone then gets its own source repository's rules; then the group's own rules are applied to the workspace folder. Once the locks are released, the [setup commands](/guide/setup#project-groups) run: each member's inside its clone, from its source repository's `.workler`, in `project` line order, then the group's own in the workspace folder. Like `init`, `add` makes sure the group's `.gitignore` lists `.worktrees/`, so a hand-written group inside an outer repository never shows its workspaces as untracked content there. The one exception is a group workspace itself (a nested group): it already lives under a `.worktrees/` that its parent group ignores, so no `.gitignore` is written there. Merely sitting in a folder called `.worktrees` does not count; the folder has to be a workspace of a group root. While it runs, `add` holds the group's lock and every usable source repository's lock (it clones from the sources and applies their rules), so a `sync` started inside a source fails with `LOCKED` until it finishes, and the other way round. `--dry-run` prints the plan per project and takes no locks.

```text
project projects/api
cloning /path/to/root/projects/api
     to /path/to/root/.worktrees/feat/projects/api
create branch feat from HEAD
linked node_modules
project tools
cloning /path/to/root/tools
     to /path/to/root/.worktrees/feat/tools
create branch feat from HEAD
group rules
copied .env.shared
project projects/api
skip   setup pnpm install (node_modules exists)
project tools
setup  pnpm install
...
group setup
setup  portler setup
done   feat
path   /path/to/root/.worktrees/feat
```

A failure after cloning began leaves the partial workspace in place; `workler status` shows which member is missing and `workler remove <name> --force` removes it. A failing setup command leaves the complete workspace in place, names the member (`projects/api: setup command failed ...`), and stops the remaining commands; `workler setup <name>` re-runs them.

## Examples

```bash
workler add feature-a                      # new branch feature-a from HEAD
workler add hotfix v1.2.0                  # new branch hotfix from tag
workler add exp origin/main                # new branch exp tracking origin/main
workler add review --checkout main         # second checkout of main
workler add spike --branch feat/spike      # workspace and branch named differently
workler add spike main --branch feat/spike # explicit branch from an explicit base
workler add isolated --copy-links          # link rules become independent copies
workler add quick --no-setup               # skip the "setup" commands for now
workler add big-change --dry-run           # just show the plan
```
