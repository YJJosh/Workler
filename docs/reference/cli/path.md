# workler path

Print a workspace's absolute path.

```bash
workler path <name>
```

## Behavior

Prints the path of the named workspace to stdout — nothing else, so it composes cleanly with command substitution. `main` is the main project itself.

This is the building block behind the [`wcd` shell helper](/guide/shell-helper).

## Output

```text
$ workler path feature-a
/path/to/project/.worktrees/feature-a
```

## Errors

- No workspace named `<name>` — printed to stderr, non-zero exit, so `cd "$(workler path nope)"` leaves your shell where it is.

## Examples

```bash
cd "$(workler path feature-a)"
code "$(workler path feature-a)"        # open in an editor
git -C "$(workler path main)" log -1    # run git in the main project
```
