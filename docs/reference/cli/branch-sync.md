# workler branch-sync

Sync **local** branches between the main project and every workspace — no remote involved.

```bash
workler branch-sync
```

## Behavior

Where [`workler sync`](/reference/cli/sync) deals with `origin`, `branch-sync` deals with branches that exist only on your machine. It works in both directions:

**Root → workspaces.**

1. Ensures every workspace has a `workler-root` remote pointing at the main project (added even when there is no `origin`, fixed if the URL is wrong).
2. Creates the root's local branches in each workspace where missing.
3. Fast-forwards workspace branches that are strictly behind the root's version.

Never touched, each skipped with a note:

- the branch currently **checked out** in a workspace
- a branch with **local-only or diverged** commits

**Workspaces → root.** Each workspace's local branches are mirrored into the root as **read-only refs** under `refs/workler/<workspace>/<branch>` — no local branches are created in the root. Stale mirrors of removed workspaces are pruned. Workler reports every workspace, then exits non-zero if any fetch, ref update, mirror, or prune operation failed.

## Output

```text
workspace feature-a
  main     up-to-date
  develop  fast-forwarded
  spike    created
  wip      skipped (checked out)
workspace review-1
  main     up-to-date
root refs (read-only, refs/workler/<workspace>/<branch>)
  feature-a  4 branches -> refs/workler/feature-a/
  review-1   1 branch -> refs/workler/review-1/
  pruned refs/workler/old-ws/ (workspace removed)
```

## Working with the mirrored refs

```bash
git for-each-ref refs/workler/                 # what did every workspace produce?
git log refs/workler/feature-a/spike           # inspect a workspace's branch
git diff main...refs/workler/feature-a/spike   # review it against main
git branch spike refs/workler/feature-a/spike  # adopt it as a real branch
```

This is the review flow for [nested/agent workspaces](/guide/nested-workspaces): agents commit on branches in their own clones, `branch-sync` makes those visible in the root without letting any workspace move your branches.

## Examples

```bash
workler branch-sync                        # both directions, all workspaces
workler branch-sync && workler remove exp  # preserve exp's branches, then delete it
```
