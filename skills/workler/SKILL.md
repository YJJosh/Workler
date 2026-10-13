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
workler remove <name> [--force]                 # refuses while the workspace holds local data
workler status | fetch | sync | branch-sync     # main project + every workspace
workler init                                    # optional: write a starter .workler
workler shell-init                              # eval output to get `wcd <name>`
```

`add` branch behavior:
- `add <name>`: new branch `<name>` from the main project's HEAD
- `add <name> <base>`: new branch starting at `<base>` (branch, tag, or commit; `origin/x` also sets upstream)
- `add <name> --branch <b>`: workspace on branch `<b>`; created from HEAD if it doesn't exist
- `add <name> --checkout <ref>`: no new branch: existing branch, or tag/commit on detached HEAD

Multi-workspace commands: `status` shows branch, ahead/behind, and clean/dirty everywhere; `fetch` runs `git fetch --prune origin` everywhere; `sync` fetches then fast-forward-only pulls (dirty or diverged workspaces are never touched); `branch-sync` fast-forwards the root's branches into every workspace and mirrors workspace branches back into the root as read-only `refs/workler/<workspace>/<branch>`. In a project group it works per member against that member's source repository, and the mirrors land there under `refs/workler-group/<group>/<workspace>/<branch>`. Mirrors of removed workspaces are pruned.

## Working in a workspace

- Typical flow: `workler add my-task`, `cd "$(workler path my-task)"`, work there, commit locally. Review with `git diff <base>` inside the clone. Never push from a workspace unless the user asks.
- Use one workspace per task or agent. `add` only clones committed work; uncommitted changes in the main project stay there.
- Workspaces nest: `workler add` inside a workspace creates one under that workspace's own `.worktrees/` (one per subagent, say).
- `add` runs the `setup` lines of `.workler` through the shell. In a repository you do not know, read `.workler` first, or add with `--no-setup` and run `workler setup <name>` once you have checked them. If a setup command fails, the workspace is kept: fix the cause and run `workler setup <name>`.
- Copy/link rules never replace an existing, different destination without `--force`, and `--dry-run` prints the plan first. Setup commands are not covered by this: they run as written, without `--force`, and can change any file they reach (through a `link`, even files in the main checkout); `--dry-run` only lists them.

## Removing a workspace

- `remove` deletes the folder for good. It refuses while the workspace holds local data (uncommitted, staged, untracked or ignored files, apart from what `.workler` produces) and lists what it found. Deal with each entry instead of passing `--force`, unless the user asks for it.
- Local branches that exist only in the workspace are lost. Keep them before removing: merge or push them as the user wants, or copy one into the root as a real branch by running `git fetch "$(workler path <name>)" <branch>:<new-branch>` there (for a group member, run from the group root: `git -C "$(workler path main/<project path>)" fetch "$(workler path <name>/<project path>)" <branch>:<new-branch>`; inside a member repository, group addresses do not resolve). `branch-sync` mirrors are not enough: they are pruned once the workspace is gone.
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
