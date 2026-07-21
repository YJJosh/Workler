# workler sync

Fetch everywhere, then fast-forward each workspace's current branch.

```bash
workler sync
```

## Behavior

Two phases, both covering the main project and every workspace:

1. **Fetching** — `git fetch --prune origin` everywhere, exactly like [`workler fetch`](/reference/cli/fetch).
2. **Updating** — where the current branch has an upstream and is strictly behind it, run a fast-forward-only merge.

Nothing is ever merged, rebased, or forced. A workspace is left untouched — with a note saying why — when:

- it has **uncommitted changes** to tracked files (untracked files, such as the ones created by copy rules, do not block a sync)
- its branch has **diverged** from its upstream (`diverged, skipped`)
- it is on a **detached `HEAD`**, or its branch has **no upstream**
- its **fetch failed** (updating against stale refs would be misleading)
- it is a **broken** clone

Every target is still reported, but the command exits non-zero after the report
if a fetch, status inspection, or fast-forward operation failed. Intentional
skips (dirty, detached, diverged, no upstream, or no origin) are not failures.

## Output

```text
fetching:
  main       fetched origin
  feature-a  fetched origin

updating:
  main       up to date
  feature-a  fast-forwarded feature-a (2 commits)
  review-1   skipped (uncommitted changes)
  spike      diverged, skipped (ahead 1, behind 3)
  old-thing  skipped (detached HEAD at 1a2b3c4)
```

`up to date (ahead N)` means the branch is ahead of its upstream and there is nothing to pull — pushing is your call.

## Examples

```bash
workler sync                      # morning routine
workler sync && workler status    # then check what was skipped and why
```

To sync **local** branches between the root and workspaces (no remote involved), see [`workler branch-sync`](/reference/cli/branch-sync).
