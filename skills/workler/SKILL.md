---
name: workler
description: Create isolated workspaces (full local clones) of a git repository, or of a group of repositories, with the workler CLI. Use when you need a separate checkout to work on a task without touching the main checkout or other agents' work.
---

# Workler

Workler creates normal local clones under `.worktrees/<name>` (not `git worktree`: each has its own HEAD, index, and local branches). An optional `.workler` file at the project root holds copy/link rules (e.g. `link node_modules`, `copy .env`; quote paths containing spaces or `#`) and `setup` commands that run in every new workspace (e.g. `setup --if-missing node_modules pnpm install`). Neither `workler init` nor a `.workler` file is required.

```
workler add <name> [base] [--branch <b>] [--checkout <ref>] [--no-setup] [--copy-links] [--force] [--dry-run]
workler path <name>                             # print a workspace's path
workler list                                    # every workspace with branch and path
workler apply [name] [--all] [--force] [--dry-run]   # re-apply copy/link rules
workler setup [name]                            # re-run the setup commands
workler remove <name> [--force]                 # refuses local files and unpreserved/unknown history
workler status | fetch | sync | branch-sync     # main project + every workspace
workler init                                    # optional: write a starter .workler
workler shell-init                              # eval output to get `wcd <name>`
```

`add` branch behavior:
- `add <name>`: new branch `<name>` from the main project's HEAD
- `add <name> <base>`: new branch starting at `<base>` (branch, tag, or commit; `origin/x` also sets upstream)
- `add <name> --branch <b>`: workspace on branch `<b>`; created from HEAD if it doesn't exist
- `add <name> --checkout <ref>`: no new branch: existing branch, or tag/commit on detached HEAD

Multi-workspace commands: `status` shows branch, ahead/behind, tracked-file clean/dirty and a separate HISTORY assessment everywhere; `fetch` runs `git fetch --prune origin` everywhere; `sync` fetches then fast-forward-only pulls (dirty or diverged workspaces are never touched); `branch-sync` fast-forwards the root's branches into every workspace and mirrors workspace branches back into the root as read-only `refs/workler/<workspace>/<branch>`. In a project group it works per member against that member's source repository, and the mirrors land there under `refs/workler-group/<group>/<workspace>/<branch>`. Mirrors of removed workspaces are pruned.

## Working in a workspace

- Typical flow: `workler add my-task`, `cd "$(workler path my-task)"`, work there, commit locally. Review with `git diff <base>` inside the clone. Never push from a workspace unless the user asks.
- Use one workspace per task or agent. `add` only clones committed work; uncommitted changes in the main project stay there.
- Workspaces nest: `workler add` inside a workspace creates one under that workspace's own `.worktrees/` (one per subagent, say).
- `add` runs the `setup` lines of `.workler` through the shell. In a repository you do not know, read `.workler` first (in a project group, every member repository's too: `add` runs each member's lines, then the group's), or add with `--no-setup` and run `workler setup <name>` once you have checked them all. If a setup command fails, the workspace is kept: fix the cause and run `workler setup <name>`.
- Copy/link rules never replace an existing, different destination without `--force`, and `--dry-run` prints the plan first. Setup commands are not covered by this: they run as written, without `--force`, and can change any file they reach (through a `link`, even files in the main checkout); `--dry-run` only lists them.

## Removing a workspace

- `remove` deletes the folder for good. It refuses while the workspace holds local data (uncommitted, staged, untracked or ignored files, apart from what `.workler` produces; that includes anything written inside a `setup --if-missing` folder, so check what such a folder holds) and lists what it found. Deal with each entry instead of passing `--force`, unless the user asks for it.
- Run `workler status` at the source project/group root. Its HISTORY column uses the same offline proof as `remove`: every workspace ref, HEAD and reflog is checked, including noncurrent branches, tags, detached commits, old stash entries and their parents, and reflog-only commits after amend/reset. A commit must be reachable from a direct local source branch/tag or detached source HEAD. Mirrors, remote-tracking refs, source stash/reflogs and loose objects are not proof. Even pushed work blocks until imported into durable source refs.
- Review unpreserved commits and ask before discarding intentionally rewritten/dropped work. Status/refusal gives a specific full ID and a copyable, escaped **Bash / Git Bash** `git -C <source> fetch --no-tags -- <workspace> <commit>:refs/heads/keep-<id>` command. Choose an unused destination source branch (never force-fetch over one), import the exact commit deliberately, then rerun status for remaining IDs. Do not rely on a workspace branch name: it may not contain the old commit. Importing a stash commit retains its parents/trees without recreating a stash slot or changing the working tree. Never auto-restore rewritten work. On PowerShell/cmd use their own literal-argument quoting or switch to Git Bash for the generated example.
- `preserved in source` is not permission to delete: separately save dirty, staged, untracked and ignored files, including data inside rule/setup outputs. Importing history does **not** back them up. `clean` in status checks only tracked files. Normal `remove` checks more and reassesses history.
- Unknown history blocks normal removal; repair the inspection rather than treating it as safe. Missing/broken/linked sources, shallow/replace/graft/alternate/partial histories, missing objects, Git warnings/errors and 30s/32-MiB per-command limits (or 30s / one million Git metadata entries) are conservative unknowns. Expired reflogs and dangling objects no longer named by refs/HEAD/reflogs are outside the proof. Avoid concurrent Git edits/GC during checks. Workler never fetches during assessment or auto-stashes, commits, rewrites history or creates a rescue archive.
- `branch-sync` mirrors are not enough: they cover branches only and are pruned once the workspace is gone. In groups, every existing member must pass against its own source before any deletion. A nonempty nested `.worktrees/` still blocks: remove children from their own level after importing their history into the parent, then import needed parent history into its source. `--force` destroys the whole directory, including nested workspaces, without saving anything; use it only when explicitly authorized to discard the data.
- Remove only workspaces you created.

## Project groups

A plain folder whose `.workler` lists repositories with `project <path>` lines is a project group. `workler add feat` there clones every listed repository into `.worktrees/feat/` in the same layout, all on branch `feat`. `<name>/<project path>` addresses one member: `workler path feat/projects/api`. Each member keeps its own `.workler`.

## With Portler

Each workspace is its own Portler project: `portler up -d` inside it gets its own ports, and in development its Portler-managed `@` volumes are separate from the main checkout's, so they start empty. Under `--prod`, a project with a top-level `name:` shares its volumes across every clone, so use a separate `--volume-set` there before changing data. Before removing a workspace, run `portler down` and then `portler clean` in it: `.portler/` counts as local data, and `remove --force` would delete the folder while its services keep running. A `setup portler setup` line in `.workler` prepares Portler's setup steps in every new workspace.

## Documentation

Read the docs for the version that is installed; Workler changes between releases. `workler --version` prints it (e.g. `0.2.2`).

- **Markdown, pinned to that release:** `https://raw.githubusercontent.com/YJJosh/Workler/v<version>/docs/<page>.md`, e.g. `.../v0.2.2/docs/reference/cli/add.md`. The `v<version>` tag is the commit the release was built from, so these pages describe exactly the CLI you have. To read many pages, `git clone --depth 1 --branch v<version> https://github.com/YJJosh/Workler` and open `docs/`.
- **Website, latest release only:** https://yjjosh.github.io/Workler/. A page such as `guide/rules` is `docs/guide/rules.md`; `reference/cli/` is `docs/reference/cli/index.md`.

Pages: `guide/` getting-started, workspaces, rules, setup, safety, sync, nested-workspaces, project-groups, shell-helper; `reference/` configuration (the `.workler` file), generated-files, api, and `cli/<command>` for each command.

A page that returns 404 at your tag, or a command or flag the CLI rejects, does not exist in your version. Follow the docs at your tag over this file, and ask the user before upgrading Workler.
