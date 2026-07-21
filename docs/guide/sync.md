# Keeping workspaces in sync

Because every workspace is an independent clone, each one has its own fetch/pull state and its own local branches. That isolation is the point — but it means clones drift apart. Four commands operate on the main project and all workspaces at once to manage the drift:

```bash
workler status
workler fetch
workler sync
workler branch-sync
```

None of them ever merges, rebases, or force-pushes. Everything is fast-forward-only, and anything unsafe is skipped with a note.

## `workler status` — where is everything?

One line per workspace: current branch (or detached SHA), ahead/behind vs its upstream, and clean/dirty:

```text
NAME       BRANCH                 UPSTREAM            STATE
main       main                   up to date          clean
feature-a  feature-a              ahead 2             dirty
review-1   main                   behind 3            clean
old-thing  (detached 1a2b3c4)     no upstream         clean
broken     -                      -                   broken: missing .git (not a clone)
```

Directories under `.worktrees/` that are not usable clones are flagged as `broken` rather than hidden. Untracked files (such as the ones created by copy rules) never count as dirty.

## `workler fetch` — update everyone's view of the remote

Runs `git fetch --prune origin` in the main project and every workspace. Workspaces without an `origin` remote are skipped with a note; a failure in one workspace (network, auth) is reported and does not stop the others. After all targets are attempted, actual failures make the command exit non-zero.

## `workler sync` — fetch, then fast-forward

`sync` fetches everything, then fast-forwards each workspace's current branch where an upstream exists:

```text
fetching:
  main       fetched origin
  feature-a  fetched origin

updating:
  main       up to date
  feature-a  fast-forwarded feature-a (2 commits)
  review-1   skipped (uncommitted changes)
  spike      diverged, skipped (ahead 1, behind 3)
```

What `sync` will never do:

- touch a workspace with uncommitted changes to tracked files (untracked files don't block a sync)
- merge or rebase a branch that has **diverged** from its upstream — it is reported `diverged, skipped`
- update anything whose fetch failed (that would fast-forward onto stale refs)
- move a detached `HEAD`

## `workler branch-sync` — share local branches between clones

`fetch`/`sync` deal with the remote. `branch-sync` deals with **local** branches that exist only on your machine, syncing them across clones in both directions:

**Root → workspaces.** Every workspace gets a `workler-root` remote pointing at the main project (added even when there is no `origin`, fixed if the URL is wrong). The root's local branches are created in each workspace if missing, and fast-forwarded when strictly behind. The branch currently checked out in a workspace is never moved, and neither is a branch with local-only or diverged commits — both are skipped with a note.

**Workspaces → root.** Each workspace's local branches are mirrored back into the root as read-only refs under `refs/workler/<workspace>/<branch>`. No local branches are created in the root — inspect the mirrors with:

```bash
git for-each-ref refs/workler/
git log refs/workler/feature-a/spike
```

Stale mirrors for removed workspaces are pruned automatically.

```text
workspace feature-a
  main     up-to-date
  spike    created
  wip      skipped (checked out)
root refs (read-only, refs/workler/<workspace>/<branch>)
  feature-a  3 branches -> refs/workler/feature-a/
```

## A typical rhythm

```bash
workler status         # morning: where is everything?
workler sync           # pull what's safe everywhere
workler branch-sync    # make yesterday's local branches visible everywhere
```
