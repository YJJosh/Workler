# The `.workler` file

`.workler` is an optional file at the project root that declares copy/link rules applied to every workspace, and setup commands run in every new workspace. Without it, Workler creates normal isolated clones and applies no rules. [`workler init`](/reference/cli/init) can create a commented starter file.

In a plain folder that holds several repositories, the same file lists them with `project` lines and turns the folder into a [project group](/guide/project-groups).

## Syntax

Line-based, like `.gitignore` but with an action first:

```txt
# full-line comment
link node_modules   # inline comment
copy .env
copy "some folder/file.txt"
copy 'another file.txt'
copy file#1.txt     # a "#" glued to a word is part of the path
setup --if-missing node_modules pnpm install
setup portler setup
```

Each non-empty line is:

```txt
<action> <path>
setup [--if-missing <path>] <command>
```

### Actions

| Action | Effect in the workspace |
| --- | --- |
| `link <path>` | Create a symlink pointing back to the main project's `<path>`. Relative symlink on POSIX. On Windows a directory becomes a junction (no elevation needed, but its target is absolute, so moving the project breaks it) and a file becomes a real symlink (needs Developer Mode or elevation). See [Rules](/guide/rules#links-on-posix-and-on-windows). |
| `copy <path>` | Copy the file or folder (recursively, preserving timestamps) into the workspace. |
| `project <path>` | Declare a Git repository below this folder as a member of a [project group](/guide/project-groups). Only meaningful in a folder that is not itself a Git repository; `add` rejects a repository whose `.workler` declares projects. The path must lead there through real folders: a symbolic link on the way is never followed, and the source counts as broken. |
| `setup <command>` | Run `<command>` through the platform shell inside the workspace, after all rules, at the end of [`workler add`](/reference/cli/add) and on [`workler setup`](/reference/cli/setup). Lines run in file order; the first failure stops the run. See [Setup commands](/guide/setup). |
| `setup --if-missing <path> <command>` | The same, but only while nothing exists at `<path>` in the workspace (a link made by a `link` rule counts when its target exists). The install line for a project that links `node_modules`: skipped when the link resolved, run when it did not. |

### Setup commands

Everything after `setup ` is the command, with surrounding whitespace trimmed and **nothing else interpreted**: no quoting rules, no comment stripping, no path checks. `setup echo "a # b"` hands `echo "a # b"` to the shell. Whether an unquoted `#` later in the line starts a comment is the shell's decision (`sh` yes, `cmd.exe` no), so keep comments on their own line. A `setup` line without a command is rejected (`missing command after "setup"`), as is one containing a NUL character.

The one exception is the optional guard right after `setup`: `--if-missing <path>` is parsed, and the command starts after it. The path follows the [path rules](#path-rules) below (relative, no `..`, quoted when it holds a space or `#`); `--if-missing` without a path, or without a command after the path, is rejected, and so is any other `--option` in that position (`unknown setup option "..."`). The guard is checked by Workler against the directory the command runs in, so it means the same on every platform.

Commands run with the workspace as the working directory and with `WORKLER_WORKSPACE`, `WORKLER_WORKSPACE_PATH`, and `WORKLER_ROOT` added to the environment; in a project group `WORKLER_GROUP`, `WORKLER_GROUP_WORKSPACE_PATH`, and (for a member's commands) `WORKLER_PROJECT` come along too.

### Comments

- A `#` at the **start of a line** or **preceded by whitespace** starts a comment that runs to the end of the line.
- A `#` **inside a quoted path**, or glued to a word (like `file#1.txt`), is part of the path.
- On a `setup` line only the leading `#` counts (`# setup pnpm install` is a disabled example); any later `#` is part of the command.
- Blank lines are ignored.

### Quoting

Quote a path with double or single quotes if it contains spaces or `#`:

```txt
copy "some folder/file.txt"
copy 'my #1 notes.md'
```

## Path rules

Paths are relative to the project root and must stay inside the project. Rejected:

| Rule | Error |
| --- | --- |
| Absolute path | `absolute paths are not allowed: "..."` |
| Contains `..` | `paths with ".." are not allowed: "..."` |
| `.` / the project root | `managing the project/workspace root is not allowed` |
| `.git` (including `./.git` and case variants) | `managing .git is not allowed` |
| `.worktrees` (including `./.worktrees`) | `managing .worktrees is not allowed` |
| Empty path | `empty path` |

Forward and backslashes both mean path separators, so a committed rule has the
same meaning on POSIX and Windows. Rules for the same path, or for a parent and
its child (`link cache` plus `copy cache/file`), are rejected as overlapping;
otherwise applying them would depend on line order and could traverse a link
created by an earlier rule. `project` lines take part in the same check: a
project cannot contain another project, and a rule cannot reach into a project
(`project projects/api` plus `link projects/api/node_modules` is rejected; that
rule belongs in `projects/api/.workler`). A file that declares projects also
cannot have a rule for `.workler` itself: `add` copies the group's file into
every group workspace, so the rule could only collide with that copy.

## Errors

Parse errors report the line, the column, and the offending line content:

```text
.workler:2:6: unterminated "..." quoted path
  2 | copy "some folder
```

Other parse errors include `unknown action "..."`, `missing path after "copy"`, `missing command after "setup"`, `missing path after "--if-missing"`, `unknown setup option "..."`, and `unexpected text after quoted path: "..."`.

## Semantics worth knowing

- **Missing sources are skipped, not errors.** `link node_modules` before an `npm install` just reports `skip` — re-run [`workler apply`](/reference/cli/apply) later.
- **Order doesn't affect the final result** because overlapping parent/child and duplicate rules are rejected; every accepted rule is independent. Application is sequential rather than all-or-nothing, so if a later rule fails, earlier successful rules remain applied.
- **Rules and setup commands are read from the parent.** A workspace is set up from the `.workler` of the project that contains it — for [nested workspaces](/guide/nested-workspaces) that is the `.workler` checked out in the parent workspace, so commit the file if nested workspaces should inherit the rules and commands.
- **In a project group, each repository's rules and setup commands apply inside its own clone**, read from that repository. The group's own `copy`/`link` rules (the lines next to the `project` lines) are applied to the workspace folder itself, with the group root as their source, and the group's own `setup` lines run there once every member's have run. `add` copies the group's `.workler` into every group workspace so the workspace can host nested group workspaces.
- **Setup commands are ordered and stop at the first failure.** The workspace is kept; [`workler setup <name>`](/reference/cli/setup) re-runs all of them. [`workler apply`](/reference/cli/apply) never runs them.
- **Existing destinations are never overwritten** without `--force` — see [Safety](/guide/safety). A source or destination whose parent is a symlink/junction is refused even with `--force`, so a rule cannot traverse outside the managed trees. A direct final symlink entry remains supported.
