---
name: workler
description: Create isolated workspaces (full local clones) of a git repository, or of a group of repositories, with the workler CLI. Use when you need a separate checkout to work on a task without touching the main checkout or other agents' work.
---

# Workler

Workler creates full local clones under `.worktrees/<name>` — **not** `git worktree`. Each clone has its own `HEAD`, index, local branches, and fetch state (multiple workspaces can share a branch via `--checkout`), and with Portler its dev `@` volumes are isolated per clone (starting empty) rather than shared like linked git worktrees. An optional `.workler` at the project root holds `copy`/`link` rules (quote paths with spaces or `#`) and `setup` commands (e.g. `setup --if-missing node_modules pnpm install`); neither `workler init` nor `.workler` is required.

```bash
workler add <name> [base] [--branch <b>] [--checkout <ref>] [--no-setup] [--copy-links] [--force] [--dry-run]
workler path <name>                                  # print workspace path
workler list                                         # workspaces with branch and path
workler apply [name] [--all] [--force] [--dry-run]   # re-apply copy/link rules
workler setup [name]                                 # re-run setup commands
workler remove <name> [--force]                      # refuses local files and unpreserved/unknown history
workler status | fetch | sync | branch-sync          # main project + every workspace
workler init | shell-init                            # starter .workler | eval for `wcd <name>`
```

`add` branches:
- `add <name> [base]`: new branch `<name>` from `HEAD` or `<base>` (`origin/x` sets upstream)
- `add <name> --branch <b>`: workspace on `<b>` (created from `HEAD` if missing; add `[base]` for a new branch from it)
- `add <name> --checkout <ref>`: no new branch (existing branch, or tag/commit on detached `HEAD`)

Multi-workspace commands (main project + every workspace):
- `status`: branch, ahead/behind, tracked clean/dirty, and offline `HISTORY` preservation proof
- `fetch` / `sync`: `git fetch --prune origin` everywhere; `sync` also fast-forwards clean, non-diverged branches
- `branch-sync`: fast-forwards root branches into workspaces and mirrors workspace branches back as read-only `refs/workler/<workspace>/<branch>` (`refs/workler-group/<group>/<workspace>/<branch>` in groups); mirrors prune on removal

## Working in a workspace

- Flow: `workler add my-task`, `cd "$(workler path my-task)"`, commit locally, review with `git diff <base>`. Never push unless asked.
- One workspace per task or agent; `add` clones committed work only. Workspaces nest under their own `.worktrees/`.
- Unfamiliar repos: inspect `.workler` (and every member's in a group) before `setup` shell commands run, or pass `--no-setup` then run `workler setup <name>`. Failed setup keeps the workspace — fix and re-run `workler setup <name>`.
- Copy/link rules never overwrite a differing destination without `--force` (`--dry-run` previews). Setup commands are unguarded and can edit any file they reach (even through a `link`); `--dry-run` only lists them.

## Removing a workspace

Remove only workspaces you created. Never pass `--force` without asking — it deletes everything (including nested workspaces) with no backup.

1. **Stop Portler** (if used): `portler down`, then `portler clean` (`.portler/` is local data; `--force` leaves services running).
2. **Remove nested workspaces first**: nonempty `.worktrees/` blocks removal; remove children at their own level after importing their history into the parent.
3. **Check `workler status`** at the source/group root: `HISTORY` runs `remove`'s offline proof — every ref, `HEAD`, and reflog commit must be reachable from a direct local source branch/tag or detached source `HEAD` (mirrors, remote-tracking refs, loose objects, and pushed commits do not count; `unknown` blocks — fix inspection instead of forcing).
4. **Import unpreserved commits deliberately**: review listed commits and ask before discarding rewritten/dropped work (never auto-restore). Fetch exact full IDs from `status`/refusal into an unused source branch (never force-fetch over one or rely on a workspace branch name; in groups, import into that member's source), then rerun `status`.
5. **Save local files separately**: `clean` (tracked only) and `preserved in source` are not permission to delete; importing history does **not** back up dirty, staged, untracked, or ignored files (including data inside rule or `setup --if-missing` folders).
6. **Run `workler remove <name>`**: deal with each listed entry instead of `--force`. In groups, every existing member must pass against its own source.

Full removal rules, limits, and shell-quoting notes: `reference/cli/remove` and `guide/safety`.

## Project groups & Portler

- **Project groups:** a plain folder whose `.workler` lists `project <path>` lines. `workler add feat` clones every member into `.worktrees/feat/` in the same layout on branch `feat`; address one member as `<name>/<project path>` (e.g. `workler path feat/projects/api`). Each member keeps its own `.workler`.
- **Portler:** each workspace gets its own ports (and isolated dev `@` volumes, above). Under `--prod`, a top-level `name:` shares volumes across all clones — pass a separate `--volume-set` before changing data. Add `setup portler setup` in `.workler` to run Portler setup in new workspaces.

## Documentation

Read docs matching `workler --version` (e.g. `0.4.0`):
- **Pinned Markdown:** `https://raw.githubusercontent.com/YJJosh/Workler/v<version>/docs/<page>.md` (e.g. `.../v0.4.0/docs/reference/cli/remove.md`, `.../v0.4.0/docs/guide/safety.md`). For many pages: `git clone --depth 1 --branch v<version> https://github.com/YJJosh/Workler`.
- **Website (latest only):** https://yjjosh.github.io/Workler/ (`guide/rules` → `docs/guide/rules.md`; `reference/cli/` → `docs/reference/cli/index.md`).
- **Pages:** `guide/` getting-started, workspaces, rules, setup, safety, sync, nested-workspaces, project-groups, shell-helper; `reference/` configuration, generated-files, api, `cli/<command>`.
- A 404 at your tag or a rejected flag means it does not exist in your version. Follow your tag's docs over this file, and ask before upgrading Workler.
