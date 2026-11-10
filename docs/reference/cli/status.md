# workler status

Show branch, upstream state, tracked-file cleanliness, and commit preservation for the main project and every workspace.

```bash
workler status
```

## Behavior

Prints one line per workspace — read-only, no git state is modified. Ahead/behind is measured against each branch's **upstream** (usually `origin/<branch>`), using whatever was last fetched — run [`workler fetch`](/reference/cli/fetch) first for fresh numbers.

Unlike [`workler list`](/reference/cli/list), directories under `.worktrees/` that are not usable clones are shown and flagged as broken rather than hidden.

## Output

```text
NAME       BRANCH     UPSTREAM     STATE  HISTORY
main       main       up to date   clean  -
feature-a  feature-a  ahead 2      dirty  2 commit(s) not preserved in source
review-1   main       behind 3    clean  preserved in source
spike      spike      no upstream clean  unknown: Git inspection failed (or exceeded the 30s / 32 MiB per-command limit)
```

| Column | Values |
| --- | --- |
| `BRANCH` | Branch name, or `(detached <sha>)` |
| `UPSTREAM` | `up to date`, `ahead N`, `behind N`, `ahead N, behind N`, or `no upstream` |
| `HISTORY` | `preserved in source`, `N commit(s) not preserved in source`, `unknown: <reason>`, or `-` for main/source rows and members not cloned |
| `STATE` | `clean`, `dirty` (uncommitted changes to **tracked** files), `unknown: git status failed`, or `broken: <reason>` |

Untracked and ignored files — including everything created by [copy rules](/reference/configuration) — never count as dirty in `STATE`. **Neither `clean` nor `preserved in source` alone means removable.** Remove also checks untracked/ignored files and nested workspaces; importing history does not back up those files.

`HISTORY` uses exactly [remove’s offline preservation policy](/reference/cli/remove#history-preservation-policy): all workspace refs/HEAD/reflogs compared against source local branches/tags and detached HEAD. Upstream ahead/behind is not this proof. Mirrors and remote-tracking refs do not count; pushed commits not yet imported into durable source refs remain blocked. Main/source rows and absent members have no repository to delete, so show `-`; an absent member does not block removal.

Unsafe rows include up to five full commit IDs and a terminal-escaped **Bash / Git Bash** example fetching one exact commit into a suggested unused source branch. Choose another unused name if needed, import deliberately, then rerun status for remaining commits. This does not restore rewritten work, recreate stash slots or preserve dirty/untracked/ignored files. Advice is bounded; further unsafe rows may require a subsequent run after resolving the displayed ones. Broken repositories, missing/broken member sources and incomplete inspections show unknown, never safe; an unknown history assessment or failed tracked-file inspection makes status exit nonzero. Unsafe but successfully inspected history is a normal status result (exit zero).

In a [project group](/guide/project-groups) there is one row per member repository, named `<workspace>/<project>`; the source repositories appear as `main/<project>`. A member that was never cloned shows `broken: missing (not cloned)`; a source reached through a symbolic link shows `broken: behind a symbolic link at <folder>, not a repository` and is never followed. A repository at a member path that is not the recorded clone of that member (an unrelated repository, or a clone made for another workspace or location) shows `broken: not the recorded clone of <project>: unrelated, or made for another location` and is left alone by every command.

```text
NAME                BRANCH  UPSTREAM     STATE                        HISTORY
main/projects/api   main    up to date   clean                        -
main/tools          main    no upstream  clean                        -
feat/projects/api   feat    no upstream  dirty                        preserved in source
feat/tools          -       -            broken: missing (not cloned) -
```

## Examples

```bash
workler fetch && workler status    # fresh ahead/behind numbers
workler status                     # quick local overview
```
