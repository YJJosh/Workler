# The `.workler` file

`.workler` is an optional file at the project root that declares copy/link rules applied to every workspace. Without it, Workler creates normal isolated clones and applies no rules. [`workler init`](/reference/cli/init) can create a commented starter file.

## Syntax

Line-based, like `.gitignore` but with an action first:

```txt
# full-line comment
link node_modules   # inline comment
copy .env
copy "some folder/file.txt"
copy 'another file.txt'
copy file#1.txt     # a "#" glued to a word is part of the path
```

Each non-empty line is:

```txt
<action> <path>
```

### Actions

| Action | Effect in the workspace |
| --- | --- |
| `link <path>` | Create a symlink pointing back to the main project's `<path>`. Relative symlink on POSIX. On Windows a directory becomes a junction (no elevation needed, but its target is absolute, so moving the project breaks it) and a file becomes a real symlink (needs Developer Mode or elevation). See [Rules](/guide/rules#links-on-posix-and-on-windows). |
| `copy <path>` | Copy the file or folder (recursively, preserving timestamps) into the workspace. |

### Comments

- A `#` at the **start of a line** or **preceded by whitespace** starts a comment that runs to the end of the line.
- A `#` **inside a quoted path**, or glued to a word (like `file#1.txt`), is part of the path.
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
created by an earlier rule.

## Errors

Parse errors report the line, the column, and the offending line content:

```text
.workler:2:6: unterminated "..." quoted path
  2 | copy "some folder
```

Other parse errors include `unknown action "..."`, `missing path after "copy"`, and `unexpected text after quoted path: "..."`.

## Semantics worth knowing

- **Missing sources are skipped, not errors.** `link node_modules` before an `npm install` just reports `skip` — re-run [`workler apply`](/reference/cli/apply) later.
- **Order doesn't affect the final result** because overlapping parent/child and duplicate rules are rejected; every accepted rule is independent. Application is sequential rather than all-or-nothing, so if a later rule fails, earlier successful rules remain applied.
- **Rules are read from the parent.** A workspace is set up from the `.workler` of the project that contains it — for [nested workspaces](/guide/nested-workspaces) that is the `.workler` checked out in the parent workspace, so commit the file if nested workspaces should inherit the rules.
- **Existing destinations are never overwritten** without `--force` — see [Safety](/guide/safety). A source or destination whose parent is a symlink/junction is refused even with `--force`, so a rule cannot traverse outside the managed trees. A direct final symlink entry remains supported.
