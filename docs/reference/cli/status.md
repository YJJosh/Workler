# workler status

Show branch, upstream state, and cleanliness for the main project and every workspace.

```bash
workler status
```

## Behavior

Prints one line per workspace — read-only, no git state is modified. Ahead/behind is measured against each branch's **upstream** (usually `origin/<branch>`), using whatever was last fetched — run [`workler fetch`](/reference/cli/fetch) first for fresh numbers.

Unlike [`workler list`](/reference/cli/list), directories under `.worktrees/` that are not usable clones are shown and flagged as broken rather than hidden.

## Output

```text
NAME       BRANCH               UPSTREAM           STATE
main       main                 up to date         clean
feature-a  feature-a            ahead 2            dirty
review-1   main                 behind 3           clean
spike      spike                ahead 1, behind 3  clean
old-thing  (detached 1a2b3c4)   no upstream        clean
broken     -                    -                  broken: missing .git (not a clone)
```

| Column | Values |
| --- | --- |
| `BRANCH` | Branch name, or `(detached <sha>)` |
| `UPSTREAM` | `up to date`, `ahead N`, `behind N`, `ahead N, behind N`, or `no upstream` |
| `STATE` | `clean`, `dirty` (uncommitted changes to **tracked** files), `unknown: git status failed`, or `broken: <reason>` |

Untracked files — including everything created by [copy rules](/reference/configuration) — never count as dirty.

## Examples

```bash
workler fetch && workler status    # fresh ahead/behind numbers
workler status                     # quick local overview
```
