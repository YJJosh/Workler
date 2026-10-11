# workler path

Print a workspace's absolute path.

```bash
workler path <name>[/<project>]
```

## Behavior

Prints the path of the named workspace to stdout — nothing else, so it composes cleanly with command substitution. `main` is the main project itself.

In a [project group](/guide/project-groups), `<name>/<project path>` prints one member of the workspace, and `main/<project path>` a source repository: `workler path feat/projects/api`, `workler path main/tools`.

This is the building block behind the [`wcd` shell helper](/guide/shell-helper).

## Output

```text
$ workler path feature-a
/path/to/project/.worktrees/feature-a
```

## Errors

- No workspace named `<name>`, or no declared project `<project>` in the group — printed to stderr, non-zero exit, so `cd "$(workler path nope)"` leaves your shell where it is.

## Examples

```bash
cd "$(workler path feature-a)"
code "$(workler path feature-a)"        # open in an editor
git -C "$(workler path main)" log -1    # run git in the main project
cd "$(workler path feat/projects/api)"  # one member of a group workspace
```
