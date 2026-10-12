# Setup commands

Copy and link rules put *files* in place. Some projects also need a *command* to run before a fresh workspace is usable — `pnpm install` when the main project has no `node_modules` to link to, a code generator, a sibling tool such as `portler setup`. `.workler` can declare those too, and [`workler add`](/reference/cli/add) runs them once the workspace is complete.

## Declaring commands

Add `setup <command>` lines next to the rules:

```txt
link node_modules
copy .env.local
setup --if-missing node_modules pnpm install
setup portler setup
```

Everything after `setup ` (or after the optional `--if-missing <path>` guard, see below) is the shell command, exactly as written. Setup lines are ordered: they run in file order, one after another, and may be interleaved with rules (the rules always run first regardless of where the lines sit).

Unlike a path, a setup command is **not** parsed by Workler. It is not quoted or unquoted, and a `#` inside it is not treated as a comment:

```txt
setup echo "ready"              # the quotes reach the shell as written
setup pnpm install --frozen-lockfile   # trailing comment? No - the shell decides
```

On POSIX, `sh` treats an unquoted `#` as the start of a comment, so the second line works as you would expect there; `cmd.exe` on Windows does not. Keep comments on their own line to stay portable. A `#` at the start of a line still starts a comment, so `# setup pnpm install` is a disabled example, and a `setup` line with nothing after it is a parse error:

```text
.workler:3:6: missing command after "setup"
  3 | setup
```

## Only when something is missing

`setup --if-missing <path> <command>` runs the command only while nothing exists at `<path>` in the workspace. That is the install line a project with `link node_modules` wants:

- When the main project has `node_modules`, the `link` rule puts a link to it in the workspace, and the install is **skipped**. Without the guard, `pnpm install` would write straight through the link into the main project's folder.
- When the link found nothing to point at (a fresh checkout of the main project, or `--copy-links` with nothing to copy), the install **runs**, and the workspace gets its own `node_modules`.

Workler checks the path itself, not the shell, so the guard means the same on macOS, Linux and Windows. Anything at the path counts: a file, a folder, or a link whose target exists. A link whose target is gone is neither present nor absent: the run stops with `<path> is a link whose target no longer exists`, because the command would collide with the stale entry. Remove the link or restore its target first. The path follows the [rule path syntax](/reference/configuration#path-rules): relative to the directory the command runs in, quoted when it holds a space or `#`, never absolute or reaching outside. `add` reports a skipped command as `skip   setup pnpm install (node_modules exists)`, and `add --dry-run` lists it as `would  setup pnpm install (only if node_modules is missing)`.

The guard is also the "already done" test that makes [`workler setup`](/reference/cli/setup) cheap to re-run: a guarded line only runs again after whatever it produced is gone. And what a guarded command creates is not local data for [`workler remove`](/reference/cli/remove): once the command has run and left its path behind, Workler records the path (as `workler.setupOutput` in the workspace's git config, or in `.workler-setup.json` in a group workspace folder), and an installed `node_modules` does not force a `--force`. The record lasts as long as the output does: once the path is gone and the line runs again, Workler drops the record before the command starts and writes it back only when the new run succeeds, so a run that dies after re-creating the path leaves local data behind, not output. The record also names the entry the command made (its device, inode and creation time), so a file you put at the path after deleting that output is local data even though the path is on record; so is an entry another tool replaced wholesale (`npm ci` recreating `node_modules`, for one), for which `remove` then asks for `--force`. A folder you made by hand at a guard path, in a workspace created with `--no-setup` say, is on no record and counts as local data like any other file; running `setup` then skips the command, which proves nothing about who made the path.

The guard cannot tell a finished install from one that died half-way. When a guarded command fails after creating its path, the failure message adds `<path> now exists, so workler setup would skip this command; remove it before re-running`, and the error details carry the path as `leftBehind`.

::: warning Monorepos
The `link node_modules` plus guard pairing assumes one `node_modules` at the root. A pnpm workspace keeps a `node_modules` in every package, and a yarn workspace links its packages back to their source (or, with Plug'n'Play, has no `node_modules` at all), so a workspace that only links the root folder either cannot resolve its dependencies or resolves them from the main checkout, and an install through the link would write into the main project. For those projects leave out the `link` line and use the project's own installer as a plain line, `setup pnpm install` or `setup yarn install` (or hand it to a sibling tool, `setup portler setup`); the package manager's cache makes a fresh install cheap.
:::

## How commands run

Commands run:

- **after** the clone, branch, and copy/link rules, so `pnpm install` sees the copied `.env` and the checked-out lockfile;
- **sequentially**, in file order; the first failure stops the run;
- with the **new workspace as the working directory**;
- through the **platform shell** (`sh -c` on macOS/Linux, `cmd.exe` on Windows) rather than your login shell, so a committed line behaves the same for every developer;
- with your environment, minus the variables a package manager sets for the scripts it runs (`npm_*`, `pnpm_*`, `yarn_*` and `INIT_CWD`, in that lowercase spelling; an `NPM_CONFIG_REGISTRY` or `PNPM_HOME` you export yourself passes through), plus:

| Variable | Value |
| --- | --- |
| `WORKLER_WORKSPACE` | the workspace name, e.g. `feature-a` |
| `WORKLER_WORKSPACE_PATH` | the directory the command runs in: the workspace, or the member clone in a [project group](#project-groups) |
| `WORKLER_ROOT` | the project whose `.workler` declared the line: the parent project; in a group, the member's source repository or the group root |
| `WORKLER_GROUP` | project groups only: the group root |
| `WORKLER_GROUP_WORKSPACE_PATH` | project groups only: the group workspace folder that holds the clones |
| `WORKLER_PROJECT` | a member's commands in a project group only: the declared project path, e.g. `projects/api` |

Only the variables that apply to a run are set. A command that runs Workler itself (a member's `workler add` for another project, say) does not pass its own group variables down.

The package-manager variables are dropped because Workler is often started from such a script (`"ws": "workler add"` in `package.json`, say): a `setup pnpm install` that inherited the caller's `npm_config_*`, `npm_lifecycle_event` or `INIT_CWD` would see the main project's package and configuration instead of the workspace's own.

Their output streams straight to your terminal under a `setup` heading per command:

```text
cloning /path/to/project
     to /path/to/project/.worktrees/feature-a
create branch feature-a from HEAD
linked node_modules
copied .env.local
skip   setup pnpm install (node_modules exists)
setup  portler setup
done   feature-a
path   /path/to/project/.worktrees/feature-a
```

When `add`'s stdout is not a terminal — a script capturing the `path` line, say — the commands' stdout is routed to stderr, so Workler's own lines remain the only thing on stdout.

## When a command fails

The first non-zero exit stops the run. The workspace is **kept**, not rolled back: a half-installed clone is still worth inspecting, and often the fix is outside the workspace (a registry down, a missing tool). `add` reports the command and its exit code, points at the retry, and exits non-zero:

```text
setup  pnpm install
 ERR_PNPM_NO_OFFLINE_META ...
workler: setup command failed in /path/to/project/.worktrees/feature-a: pnpm install (exit code 1)
the workspace was kept; fix the problem and re-run `workler setup feature-a`
```

## Re-running and skipping

[`workler setup <name>`](/reference/cli/setup) re-runs every command for an existing workspace — after a failure, or after `.workler` gained a line. Guarded lines whose path exists are skipped again. Inside a workspace, bare `workler setup` targets that workspace, like bare `apply`:

```bash
workler setup feature-a
cd "$(workler path feature-a)" && workler setup
```

`workler add <name> --no-setup` creates the workspace without running the commands; `workler setup <name>` runs them later. `add --dry-run` lists what would run as `would  setup ...` lines.

Setup lines run commands from the repository, the way a package manager runs a project's lifecycle scripts. To opt out for a whole shell or CI job rather than one `add`, set `WORKLER_NO_SETUP=1` in the environment: every `workler add` then behaves as with `--no-setup` (`0` and the empty value mean off, any other value on). Either way `add` prints one line naming what it skipped, `skip   setup (3 commands, --no-setup)` or `skip   setup (3 commands, WORKLER_NO_SETUP)`, and nothing when the project declares no commands. The variable does not stop an explicit `workler setup <name>`: you asked for the commands.

```bash
WORKLER_NO_SETUP=1 workler add quick     # clone and rules only
workler setup quick                      # runs the commands anyway
```

[`workler apply`](/reference/cli/apply) is unaffected: it (re-)applies only the copy/link rules and never runs commands, so refreshing `.env` cannot trigger a reinstall.

## Nested workspaces

Setup commands follow the same source as rules: a [nested workspace](/guide/nested-workspaces) runs the `setup` lines of the `.workler` checked out in its immediate parent, with `WORKLER_ROOT` pointing at that parent. Commit `.workler` if nested workspaces should inherit the commands.

## Project groups

In a [project group](/guide/project-groups), every repository keeps its own `setup` lines, and the group's `.workler` (the file with the `project` lines) may have some of its own. `workler add feat` at the group root clones every member first, then runs:

1. each member's commands inside its clone, read from that member's source repository, in `project` line order (`WORKLER_ROOT` is the source, `WORKLER_PROJECT` the declared path);
2. the group's own commands in the workspace folder, next to the clones (`WORKLER_ROOT` is the group root).

```text
project projects/api
setup  pnpm install
...
project tools
skip   setup pnpm install (node_modules exists)
group setup
setup  portler setup
done   feat
```

A group-level command can rely on every clone being there, so that is the place for something that works across the repositories. A failing command stops everything that follows, and the error names the member (`projects/api: setup command failed in ...`) while the retry hint repeats the address that was run. `workler setup feat` re-runs all of it, `workler setup feat/projects/api` one member, and bare `workler setup` inside a member clone or inside the workspace folder does the matching thing. A member that is not a usable clone, or whose source repository is missing, not a repository, or behind a symbolic link, is skipped with a `project <path>: skipped (...)` line; nothing is followed or guessed, exactly as with `apply`.

A group-level guard may point into a member (`setup --if-missing projects/api/generated <command>`), which the group's `copy`/`link` rules may not. The group's record, `.workler-setup.json` in the workspace folder, then names the path from the folder, and [`remove`](/reference/cli/remove) and the listing's `clean` count it as that member's output rather than as its local data, exactly as if the member's own `.workler` had made it. Such a guard has to spell the project's path the way the `project` line does (`projects/api/generated` for `project projects/api`, never `PROJECTS/API/generated`): the file judges overlap case-insensitively, but a case-sensitive file system would put the command's output outside the member while the member's check exempted its own path, so a differently spelled guard is a configuration error. Two more guard paths are rejected in a group's file as a configuration error: `.workler`, which `add` copies into every group workspace so it is never missing, and `.workler-setup.json` (or anything below it), which the command would create right where `setup` writes the record.

## Locking

Setup commands can run for minutes, so they run **outside** the per-project locks: `add` releases them once the workspace is complete, before the first command starts, and `workler setup` never takes them. Other workspaces can be added, listed, or removed meanwhile. The flip side is that nothing stops `workler remove --force` from deleting a workspace whose install is still running — the same care you would take with any long-running process in a directory.
