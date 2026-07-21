# Safety, `--force`, and `--dry-run`

Workler's file-rule commands are conservative by default: nothing that exists is overwritten by `add`/`apply`, and both commands support a dry-run plan. The `.worktrees` containment directory itself must be a real directory, never a symlink or junction, so clone creation and removal cannot escape the project.

## Nothing is overwritten by default

`add` and `apply` never replace an existing destination. Two states count as *already done* and are reported `ok`:

- a symlink that already points at the right source (*already linked*)
- a copy whose destination content matches the source (*destination matches source*)

Anything else — a symlink pointing somewhere else, a regular file, a directory — is a **conflict**. The error shows both sides and what is currently in the way:

```text
cannot link node_modules: destination already exists
  source:      /path/to/project/node_modules
  destination: /path/to/project/.worktrees/feature-a/node_modules (existing directory)
re-run with --force to replace the destination
```

Conflicts are detected by content, not timestamps — a copied `.env` you have since edited in the workspace is a conflict, not silently "up to date".

## `--dry-run`

Available on [`apply`](/reference/cli/apply) and [`add`](/reference/cli/add). Nothing is written, cloned, or locked: it prints the plan and exits. `add` also uses this rule preflight before a real clone, so malformed rules and existing source symlink-ancestor traversal fail without leaving a workspace behind.

`apply --dry-run` runs against a workspace that already exists, so it sees the real destinations and reports exactly what it would copy, link, skip, replace, or conflict on:

```bash
$ workler apply feature-a --dry-run
dry run: nothing will be changed
conflict copy .env
  source:      /path/to/project/.env
  destination: /path/to/project/.worktrees/feature-a/.env (existing regular file, contents differ from source)
ok     link node_modules (already linked)
1 conflict; re-run with --force to replace the destination
```

`add --dry-run` prints the whole plan — clone, branch, then the rules — and creates no clone:

```bash
$ workler add feature-b --dry-run
dry run: nothing will be created
would clone /path/to/project
         to /path/to/project/.worktrees/feature-b
would create branch feature-b from HEAD
would  copy .env -> /path/to/project/.worktrees/feature-b/.env
would  link node_modules -> /path/to/project/.worktrees/feature-b/node_modules
```

One limit worth knowing: because the workspace does not exist yet, `add --dry-run` plans every rule against an empty destination, so it always reports `would` and never `conflict`. A real `add` clones the tracked files first, so a rule whose target is **committed** (a tracked `.env`, say) can still conflict at that point and stop the setup. `apply --dry-run` on the created workspace is what predicts that accurately.

## `--force`

Replaces conflicting destinations, and says what it replaced. Workler first
builds the replacement beside the destination, then moves the old entry aside
and installs the completed replacement; if construction or installation fails,
the original is preserved or restored. A symlink/junction in a rule source's
or destination's parent path is never followed and cannot be overridden with
`--force`; a direct final symlink entry remains supported.

```text
copied .env (replaced existing regular file)
```

`--force` also appears on [`workler remove`](/reference/cli/remove), where it means something different: remove the workspace even though it has uncommitted changes.

## The same caution everywhere else

The safety-first stance runs through the whole CLI:

- [`workler remove`](/reference/cli/remove) refuses to delete a workspace with any local changes — untracked and ignored files included, since deletion is permanent.
- [`workler sync`](/reference/cli/sync) only ever fast-forwards; dirty workspaces and diverged branches are skipped, never merged or rebased.
- [`workler branch-sync`](/reference/cli/branch-sync) never moves a checked-out branch or one with local-only commits.
- Untracked files created by copy rules never count as "dirty" for `status` and `sync`. Only `remove` treats them as blocking — it is the one command that would delete them.
