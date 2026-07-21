# Getting started

## Install

Workler needs Node.js `>= 18` and `git` on your `PATH`.

```bash
npm install -g workler
workler help
```

## Create a workspace

Run `add` from any Git repository. There is no initialization step and no required configuration file.

```bash
workler add feature-a
```

Workler excludes `.worktrees/` locally, clones the project into `.worktrees/feature-a`, and creates and checks out a new branch named `feature-a`:

```text
cloning /path/to/project
     to /path/to/project/.worktrees/feature-a
create branch feature-a from HEAD
no workspace rules
done   feature-a
path   /path/to/project/.worktrees/feature-a
```

The workspace is a full, independent clone with its own `HEAD`, index, local branches, and fetch state.

Not sure what a command will do? Preview the full plan without changing anything:

```bash
workler add feature-b --dry-run
```

## Optional copy and link rules

Create `.workler` only when a fresh workspace needs local files that Git does not carry:

```txt
link node_modules   # symlink back to the main project
copy .env           # copy into the workspace
```

- `link <path>` is useful for large, regenerable directories such as `node_modules`.
- `copy <path>` is useful for local configuration that each workspace may change independently, such as `.env`.

Rules are applied automatically by `workler add`. If you add or change them later, refresh an existing workspace with:

```bash
workler apply feature-a
```

[`workler init`](/reference/cli/init) is an optional convenience that creates a commented starter `.workler`, prepares `.worktrees/`, and records the local Git settings. You do not need it before using any command in a Git repository.

See [Copy & link rules](/guide/rules) for the complete syntax and safety behavior.

## Move around

```bash
workler list                        # every workspace, its branch, its path
cd "$(workler path feature-a)"     # enter a workspace
```

Or load the shell helper once and use `wcd`:

```bash
eval "$(workler shell-init)"    # put this in your shell rc
wcd feature-a
wcd main
```

## Everyday commands

| Command | What it does |
| --- | --- |
| `workler add <name>` | Clone a new workspace on a new branch and apply optional rules |
| `workler apply <name>` | Re-apply the rules to a workspace |
| `workler list` | Show every workspace with its branch and path |
| `workler path <name>` | Print a workspace's path |
| `workler remove <name>` | Delete a workspace (refuses if it has uncommitted changes) |
| `workler status` | Show branch, ahead/behind, and clean/dirty state |
| `workler sync` | Fetch everywhere and fast-forward what is safe |

See the [CLI reference](/reference/cli/) for every command and flag.

## Where to go next

- [Workspaces & branches](/guide/workspaces) — bases, `--branch`, `--checkout`, and detached checkouts.
- [Copy & link rules](/guide/rules) — the optional `.workler` format.
- [Keeping workspaces in sync](/guide/sync) — `status`, `fetch`, `sync`, and `branch-sync`.
- [Programmatic API](/reference/api) — create, inspect, list, and remove workspaces from TypeScript or JavaScript.
