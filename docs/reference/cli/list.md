# workler list

Show every workspace with its branch and path.

```bash
workler list
```

## Behavior

Lists the main project (as `main`) and every clone under `.worktrees/`, with each one's current branch and absolute path. There is no header row — the output is three space-padded columns, so it stays easy to pipe into `awk`/`cut`. A detached `HEAD` shows the short commit sha in the branch column instead of a branch name.

Directories under `.worktrees/` with no `.git` entry are not clones and are left out. A clone git cannot read *is* still listed, with `?` in the branch column; [`workler status`](/reference/cli/status) is the command that explains why, flagging it as `broken`.

## Output

```text
main       main       /path/to/project
feature-a  feature-a  /path/to/project/.worktrees/feature-a
hotfix     1a2b3c4    /path/to/project/.worktrees/hotfix
```

Here `hotfix` has a detached `HEAD`, so its branch column shows the commit it sits on. (For a header row and upstream/clean state, use [`workler status`](/reference/cli/status).)

## Examples

```bash
workler list
cd "$(workler path feature-a)"    # then jump into one
```
