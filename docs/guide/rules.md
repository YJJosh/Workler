# Copy & link rules

The optional `.workler` file at the project root declares what a fresh workspace needs. Without it, Workler simply creates the clone and branch. When present, it is applied automatically at the end of `workler add` and can be re-applied with [`workler apply`](/reference/cli/apply).

## The format

Line-based, like `.gitignore` but with an action first:

```txt
# full-line comment
link node_modules   # inline comment
copy .env
copy "some folder/file.txt"
copy 'another file.txt'
```

Each line is `<action> <path>`:

- **`link <path>`** creates a symlink in the workspace pointing back to the main project's copy.
- **`copy <path>`** copies the file or folder into the workspace.

Blank lines are ignored. A `#` at the start of a line or preceded by whitespace starts a comment; a `#` inside a quoted path (or glued to a word, like `file#1.txt`) does not. Quote a path with double or single quotes if it contains spaces or `#`.

## Choosing link vs copy

| | `link` | `copy` |
| --- | --- | --- |
| Best for | Big, regenerable directories: `node_modules`, build caches | Local config a workspace may change: `.env`, local databases |
| Disk cost | None — one shared copy | Full copy per workspace |
| Independence | Changes are shared with the main project | Each workspace has its own |

A linked `node_modules` means a new workspace runs instantly with zero extra disk — but an `npm install` in any workspace changes the shared directory for everyone. Copy instead if workspaces need different dependency states.

## Path restrictions

Paths must stay inside the project. The parser rejects, with the line, column, and offending line content:

- absolute paths
- paths containing `..`
- `.` (the whole project/workspace root)
- `.git` (including leading `./` and case variants)
- `.worktrees`
- duplicate or parent/child-overlapping rule paths

Backslashes and forward slashes are both treated as separators so committed
rules keep the same meaning on every supported platform.

```text
.workler:3:6: paths with ".." are not allowed: "../outside"
  3 | copy ../outside
```

## How rules are applied

For each rule, the destination inside the workspace is inspected first:

- **Source missing** → the rule is skipped with a note (`skip ... source does not exist`). This is fine — e.g. `link node_modules` before anyone has run `npm install`.
- **Already correct** → reported as `ok` and left alone. A symlink that already points at the right source counts as *already linked*; a copy whose destination content matches the source counts as *up to date*.
- **Fresh** → the symlink is created (`linked`) or the content copied (`copied`).
- **Anything else** — a symlink pointing elsewhere, a regular file, a directory — is a **conflict**. Nothing is overwritten; see [Safety, `--force`, `--dry-run`](/guide/safety).

Workler never follows a symlink or junction in a rule source's or
destination's parent path. That case is refused even with `--force`, and is
caught during workspace-creation preflight when already present in the source,
because traversal could read, write, or delete outside the managed trees. A
symlink at the rule path itself is still supported; only symlink *ancestors*
are refused.

### Links on POSIX and on Windows

On macOS and Linux, links are relative symlinks, so a workspace keeps working if the whole project directory is moved.

On Windows the behavior differs by source type, and it is worth knowing before you write a `link` rule:

- **A directory source** (`link node_modules`) becomes a **junction**. Junctions need no elevation, but Windows stores their target as an **absolute** path — so moving the project directory breaks them. Re-run [`workler apply`](/reference/cli/apply) after a move to repoint them.
- **A file source** (`link .env.local`) becomes a real symlink, which on Windows requires **Developer Mode or an elevated shell**. Without that privilege the rule fails with `EPERM`; Workler does not silently fall back to copying. Use `copy` instead for files if you would rather not enable Developer Mode.

## Re-applying rules

Rules are applied when a workspace is created, but you can refresh at any time — after editing `.workler`, or after `.env` changed in the main project:

```bash
workler apply feature-a          # one workspace
workler apply --all              # every workspace
workler apply                    # run inside a workspace: refresh from its parent
workler apply feature-a --dry-run
```

`apply` follows the same conflict rules as `add`: an up-to-date destination is `ok`, a differing one is a conflict until you pass `--force`. Rules run sequentially, not as one transaction; if a later rule fails, earlier successful rules remain applied.

## Commit the file

If you use `.workler`, commit it so it documents what a working checkout needs and [nested workspaces](/guide/nested-workspaces) inherit the same rules.
