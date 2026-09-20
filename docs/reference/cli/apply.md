# workler apply

(Re-)apply the copy/link rules from `.workler` to workspaces. If the optional file is absent or empty, there are no rules to apply.

```bash
workler apply [name] [--all] [--copy-links | --no-copy-links] [--force] [--dry-run]
```

## Behavior

| Invocation | Effect |
| --- | --- |
| `workler apply <name>` | Apply the rules to that workspace |
| `workler apply --all` | Apply the rules to every workspace (except `main`) |
| `workler apply` (inside a workspace) | Refresh this workspace from its immediate parent's `.workler` |
| `workler apply` (in the main project) | Error — say which workspace, or `--all` |

For each rule, an up-to-date destination is reported `ok` and left alone; a missing source is skipped; anything else in the way is a conflict that requires `--force`. See [Safety, `--force`, `--dry-run`](/guide/safety) for the exact semantics.

Typical reasons to re-run `apply`: you edited `.workler`, `.env` changed in the main project, or a rule was skipped earlier because its source didn't exist yet.

## Converting links to copies

`workler apply <name> --copy-links` turns a workspace that was created with symlinks into one with its own files:

```text
copied node_modules (link rule, copied instead) (replaced existing symlink to the source)
ok     copy .env (destination matches source)
```

A symlink that still points at its source holds no data, so it is converted without `--force`; the copy is staged next to the link and swapped in, so a failed copy leaves the link in place. Anything else in the way (a directory, a symlink pointing elsewhere) is still a conflict. The mode is stored in the workspace, so later plain `apply` and `apply --all` runs keep the copies. See [Copying instead of linking](/guide/rules#copying-instead-of-linking).

## Options

| Flag | Description |
| --- | --- |
| `--all` | Every workspace; cannot be combined with `[name]` |
| `--copy-links` | Apply `link` rules as copies and remember that for the workspace. Existing symlinks to the source are converted to copies without `--force` |
| `--no-copy-links` | Go back to symlinks. The existing copies are data, so replacing them needs `--force` |
| `--force` | Replace destinations that already exist and differ |
| `--dry-run` | Print what would happen without changing anything |

## Output

Sources and destinations are printed as absolute paths.

```text
applying feature-a
ok     link node_modules (already linked)
copied .env (replaced existing regular file)
skip   copy fixtures/db.sqlite (source does not exist: /path/to/project/fixtures/db.sqlite)
```

With `--dry-run`, actions become `would ...` lines, conflicts are listed with both sides, and a summary asks for `--force`:

```text
dry run: nothing will be changed
conflict copy .env
  source:      /path/to/project/.env
  destination: /path/to/project/.worktrees/feature-a/.env (existing regular file, contents differ from source)
ok     link node_modules (already linked)
1 conflict; re-run with --force to replace the destination
```

## Errors

- No workspace named `<name>`.
- `--all` combined with a workspace name.
- `--copy-links` combined with `--no-copy-links`.
- Bare `apply` outside a workspace.
- A conflicting destination without `--force` — the error shows source, destination, and what is currently there.

## Examples

```bash
workler apply feature-a                 # one workspace
workler apply --all                     # everything
workler apply --all --dry-run           # what would change anywhere?
workler apply feature-a --force         # take the main project's .env again
workler apply feature-a --copy-links    # convert its symlinks into independent copies
workler apply feature-a --no-copy-links --force   # and back to symlinks
cd "$(workler path feature-a)" && workler apply   # refresh from inside
```
