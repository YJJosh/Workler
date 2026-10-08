# workler setup

Re-run the [`setup` commands](/guide/setup) from `.workler` in an existing workspace.

```bash
workler setup [name[/<project>]]
```

## Behavior

| Invocation | Effect |
| --- | --- |
| `workler setup <name>` | Run the commands in that workspace |
| `workler setup` (inside a workspace) | Run this workspace's commands from its immediate parent's `.workler` |
| `workler setup` (in the main project) | Error — say which workspace |
| `workler setup main` | Error — commands never run in the main project |
| `workler setup <name>` (in a [project group](/guide/project-groups)) | Every cloned member's commands from its source repository's `.workler`, in `project` line order, then the group's own commands in the workspace folder. A member that is not a usable clone (never cloned, a symbolic link or file at its path or on the way to it, a repository that is not the recorded clone), or whose source is missing, not a repository, or behind a symbolic link, is skipped with a `project <path>: skipped (...)` line |
| `workler setup <name>/<project>` (in a project group) | That one member only, from its source repository |
| `workler setup` (inside a member clone) | Same as `setup <name>/<project>` at the group root |
| `workler setup` (inside a group workspace folder) | Same as `setup <name>` at the group root |

The commands run exactly as at the end of [`workler add`](/reference/cli/add): sequentially, in file order, through the platform shell, with the workspace as the working directory and `WORKLER_WORKSPACE`, `WORKLER_WORKSPACE_PATH`, and `WORKLER_ROOT` (plus the group variables in a project group) in the environment. A `setup --if-missing <path>` line is skipped while its path exists. The first failing command stops the run and `setup` exits non-zero. Copy/link rules are not touched — that is [`workler apply`](/reference/cli/apply).

Typical reasons to run it: a command failed during `add` and the cause is fixed, the workspace was created with `--no-setup`, `.workler` gained a `setup` line, or something a guarded line produces (a `node_modules` folder, say) was deleted.

`setup` does not take the project lock, so it can run while sibling workspaces are added or removed.

## Output

A heading per command, followed by the command's own output; a `skip` line for a guarded command whose path exists:

```text
skip   setup pnpm install (node_modules exists)
setup  portler setup
done   feature-a
```

In a project group, a `project` heading per member that has commands, then `group setup` for the group's own:

```text
project projects/api
setup  pnpm install
...
project tools: skipped (not cloned)
group setup
setup  portler setup
done   feat
```

Without any `setup` lines anywhere:

```text
no setup commands
```

When stdout is not a terminal, the commands' stdout goes to stderr so Workler's own lines stay the only thing on stdout.

## Errors

- No workspace named `<name>`, or `<name>` is `main`; in a project group, no declared project `<project>`, or that member is not a usable clone, or its source repository is unusable.
- Bare `setup` outside a workspace.
- Bare `setup` inside a member clone whose source repository is missing, not a repository, or behind a symbolic link.
- A command exits non-zero or is killed by a signal — the error names the command and the exit code (in a group, prefixed with the member's project path), and the remaining commands do not run:

```text
workler: setup command failed in /path/to/project/.worktrees/feature-a: pnpm install (exit code 1)
the workspace was kept; fix the problem and re-run `workler setup feature-a`
```

## Examples

```bash
workler setup feature-a                          # retry after a failed add
workler add feature-b --no-setup && workler setup feature-b
cd "$(workler path feature-a)" && workler setup  # from inside
workler setup feat                               # in a project group: every member, then the group
workler setup feat/projects/api                  # one member only
```
