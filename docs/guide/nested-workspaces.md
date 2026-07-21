# Nested workspaces

Workspaces are ordinary clones, so Workler also works *inside* them. Running `workler add` inside a managed workspace creates the new workspace under that workspace's own `.worktrees/` — useful when you work on multiple features and each feature workspace needs more checkouts, e.g. one per subagent:

```txt
project/
  .worktrees/
    feature-a/
      .worktrees/
        agent-1/
        agent-2/
```

```bash
cd "$(workler path feature-a)"
workler add agent-1
workler add agent-2
```

## How the nested level behaves

- **Every command operates on the nearest enclosing workler project.** `list`, `path`, `remove`, `apply`, and `add` run inside `feature-a` only see `feature-a`'s own workspaces — the root's other workspaces don't leak in.
- **Optional rules come from the parent checkout.** When `.workler` is present, a nested workspace applies the copy checked out in its parent—commit it if nested workspaces should inherit the rules.
- **`link` targets resolve to the immediate parent.** `agent-1/node_modules` links to `feature-a/node_modules`, which may itself be a link back to the root — the chain resolves transparently.
- **Bare `workler apply` refreshes from the immediate parent.** Run inside `agent-1`, it re-applies `feature-a`'s rules to `agent-1`.
- **Nesting depth is unlimited.** Each clone's `workler.root` git config points at its immediate parent, so discovery always finds the nearest level.

## Why this is useful for agents

Give each coding agent its own full checkout:

- Agents can fetch, switch branches, and commit **without any shared repository state** — no lock contention, no ref surprises, none of `git worktree`'s same-branch restrictions.
- Each agent workspace starts ready to run: `node_modules` linked, `.env` copied.
- From `feature-a`, plain `workler status` shows what every agent's checkout is doing, and [`workler branch-sync`](/reference/cli/branch-sync) mirrors each agent's branches back as `refs/workler/agent-1/...` for review — without letting an agent move any of your branches.

## Cleaning up

Nested workspaces are removed like any other, from their own level:

```bash
cd "$(workler path feature-a)"
workler remove agent-1
```

Removing `feature-a` itself from the root with `--force` also removes everything nested under it. The normal local-data check sees the ignored `.worktrees/` entry and refuses, so nested checkouts cannot be deleted accidentally. Before forcing removal, rescue any agent work you care about (e.g. run `workler branch-sync` inside `feature-a`, then again at the root).
