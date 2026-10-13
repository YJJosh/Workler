# workler list

Show every workspace with its branch and path.

```bash
workler list
```

`workler ls` is an alias.

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

In a [project group](/guide/project-groups) each group workspace is one line. Its branch column shows the branch when every member is on it, `mixed` when they differ, `detached` when no member is on a branch, and `incomplete` when a member is missing or broken (a workspace left behind with no member cloned at all is listed that way too); `main` shows the branch the source repositories share. [`workler status`](/reference/cli/status) shows the members one by one.

## Examples

```bash
workler list
cd "$(workler path feature-a)"    # then jump into one
```
