# What is Workler?

Workler is a local workspace manager. It gives you several parallel checkouts of the same project — one per feature, experiment, or coding agent — each one ready to run.

It does **not** use `git worktree`. Instead, it creates normal local clones under `.worktrees/`. An optional `.workler` file can copy or link untracked things a checkout needs—`node_modules`, `.env`, or local data—into place immediately.

## The problem

A fresh checkout of a project is rarely ready to work in:

- `node_modules` is missing, so the first thing every new checkout costs you is a full install.
- `.env` and other untracked local files don't come along with a clone, so you copy them by hand — or the dev server fails until you remember to.
- `git worktree` shares one repository between all checkouts, which is exactly what you don't want when several agents (or several of you) fetch, switch branches, and rewrite refs at the same time.

## The idea

If fresh workspaces need local files, declare them in an optional `.workler` file at the project root:

```txt
link node_modules   # symlink back to the main project
copy .env           # copied into the workspace
```

Then create workspaces:

```bash
workler add feature-a
```

Workler:

1. **Clones** the main project into `.worktrees/feature-a` — a full, independent local clone with its own `HEAD`, index, and local branches.
2. **Creates and checks out a branch** — by default a new branch named after the workspace, started from the main project's current `HEAD`. Bases, existing branches, tags, and detached checkouts are available via `[base]`, `--branch`, and `--checkout` (see [Workspaces & branches](/guide/workspaces)).
3. **Applies the rules** — `link node_modules` symlinks the workspace's `node_modules` back to the main project's, `copy .env` copies the file in.

The result is a checkout you can `cd` into and run, with no install step and no manual file shuffling.

## Why real clones instead of git worktree?

- **Isolation.** Each workspace has its own fetch/pull state and its own local branches. A `git fetch` or branch switch in one workspace cannot affect another — important when workspaces are driven by parallel coding agents.
- **No sharing constraints.** `git worktree` refuses to check out the same branch twice; Workler workspaces can sit on the same branch via `--checkout`.
- **Ordinary tooling.** Every workspace is a plain repository, so every git tool, editor, and script works in it without knowing about Workler.

The trade-off is that clones drift apart — so Workler ships [multi-workspace commands](/guide/sync) (`status`, `fetch`, `sync`, `branch-sync`) that keep the main project and every workspace fetched, fast-forwarded, and aware of each other's branches, without ever merging, rebasing, or force-pushing anything.

## What Workler is not

- **Not a build tool or process runner.** Workler prepares checkouts; it does not run your services. (For that, see its sibling project [Portler](https://github.com/YJJosh/Portler).)
- **Not a remote/CI tool.** Everything happens on your machine, between local directories.
- **Not a wrapper around `git worktree`.** Workspaces are full clones on purpose.

## Requirements

- Node.js `>= 18`
- `git` on your `PATH`

## Next steps

- [Getting started](/guide/getting-started) — install Workler and create your first workspace.
- [Copy & link rules](/guide/rules) — the `.workler` file format.
- [CLI reference](/reference/cli/) — every command and flag.
