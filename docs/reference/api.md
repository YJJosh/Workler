# Programmatic API

Workler can be used as a library, so tools can create, list, and remove
workspaces without shelling out to the CLI or parsing console text.

## Install

```bash
npm install workler
```

The package includes TypeScript declarations and supports both `import` and
`require`. Its API is synchronous.

## Quick start

```ts
import { createWorkspace, listWorkspaces, removeWorkspace } from "workler";

const root = "/path/to/git-project";

const ws = createWorkspace(root, { name: "agent-1" });
console.log(ws.path, ws.branch, ws.head);

for (const info of listWorkspaces(root)) {
  console.log(info.name, info.branch ?? info.shortHead, info.clean, info.broken ?? "ok");
}

removeWorkspace(root, "agent-1", { force: true });
```

The API and the CLI share the same core: `workler add` and
`createWorkspace()` are the same code path.

## Contract

- **Explicit roots.** Every function takes the project root as its first
  argument. Nothing reads `process.cwd()` or mutates global state, so a
  long-running process can drive many projects concurrently. To get
  CLI-style discovery of the nearest enclosing project, call
  `findWorklerRoot(startDir)` yourself.
- **Synchronous.** All functions are synchronous, like the CLI.
- **Structured domain errors.** Validation, project/workspace state, rule,
  setup, and lock failures throw `WorklerError` with a stable `code` (plus
  `details`); the `message` is the same human-readable text the CLI prints.
  Unexpected host failures from Node/Git (for example an I/O permission error)
  may remain ordinary `Error` instances and should still be caught. Codes include
  `NOT_INITIALIZED`, `NOT_A_GIT_REPO`,
  `WORKSPACE_EXISTS`, `WORKSPACE_NOT_FOUND`, `WORKSPACE_DIRTY`,
  `BRANCH_EXISTS`, `BAD_REF`, `INVALID_NAME`, `INVALID_OPTIONS`,
  `CONFIG_INVALID`, `RULE_CONFLICT`, `SETUP_FAILED`, `SETUP_COMMAND_FAILED`,
  and `LOCKED`.
- **Workspaces live in `<root>/.worktrees/<name>`** — the same
  project-local layout the CLI uses, including nested workspaces (pass a
  workspace's path as the root to manage its own `.worktrees/`). The
  `.worktrees` containment directory must not be a symlink or junction.
- **A root may be a [project group](/guide/project-groups)**: a non-Git
  folder whose `.workler` declares `project <path>` lines. The same functions
  then create, list, and remove group workspaces; the results carry a
  `projects` array with one entry per member.

## Functions

### `initProject(root): InitResult`

Same as the optional `workler init` helper: creates `.workler` (if missing),
`.worktrees/`, marks the repository with `workler.*` Git config, and adds
`.worktrees/` to `.git/info/exclude` (or `.gitignore` for non-Git roots).
Ordinary Git repositories do not need initialization. Idempotent;
the result reports whether the config file was created. In a non-Git folder
it declares the repositories `discoverProjects` finds: the result lists them
as `projects` and `discoveredProjects`, and any it could not write (a path
holding both quote characters, a backslash, or a line break) as `unwritableProjects`. A repository whose path overlaps one the file already declares, or one discovered before it, the way the parser compares paths (case-insensitively, and a parent against its children) is returned under `overlappingProjects` with the path it overlaps, and left out so the written file parses. An existing `.workler` that does not parse is left as is; its parse error is returned as `configError` and the folder is still prepared.

### `inspectProject(root): ProjectInfo`

Non-throwing inspection: `{ root, exists, gitRepo, marked,
configFileExists, workspacesDirExists, initialized, parent, projects,
isGroup, configError?, memberOf? }`. Every Git repository is immediately
usable and reports `initialized: true`; a non-Git directory does so only when
`.workler` explicitly marks it. `parent` is set when the root is itself a
managed workspace (nested workspaces), or a group workspace folder (then it
is the group root). For a member clone of a group workspace it is the source
repository, but only while that is a usable repository reached without
symbolic links; a replacement at the source path leaves `parent` undefined,
and a bare `apply` inside the clone refuses. `projects` lists the declared `project` paths of a group
in file order (always empty for a Git repository) and `isGroup` is true when
there are any. `configError` carries the parse error when `.workler` cannot
be read. `memberOf` is `{ group, workspace, project }` for a member clone of
a group workspace, whether or not its source is still usable.

### `discoverProjects(root): string[]`

Git repositories directly below a folder or one level deeper, as portable
relative paths in sorted order — what `initProject` declares in a non-Git
folder. Hidden directories, `node_modules`, and linked `git worktree`
checkouts are skipped.

### `createWorkspace(root, options): CreateWorkspaceResult`

Same semantics as [`workler add`](/reference/cli/add). `options`:
`{ name, base?, branch?, checkout?, force?, copyLinks?, setup?, setupStdout?, setupStdio?, onSetupOutput? }` with the exact `add` rules.
`checkout` is exclusive, while `base` and `branch` may be combined to create
an explicitly named branch from an explicit start point; `name` alone creates
a new branch from `HEAD`. Optional `onProgress(message)` and
`onRuleResult(result)` callbacks stream what the CLI would print. The
result carries `path`, `branch` (undefined when detached), `head`,
`detached`, `copyLinks`, the structured copy/link `rules` outcome, and the
`setup` outcome (undefined when `setup: false` skipped the commands).

`copyLinks: true` is `add --copy-links`: `link` rules are applied as
independent copies, and their results carry `copiedLink: true` while
`action` stays `'link'`.

`.workler` copy/link rules are applied exactly as with the CLI, including
conflict detection and `force` replacement. If configuring the clone fails
after it was created (bad config, rule conflict), the error is
`SETUP_FAILED` and the clone is left in place for inspection — the same
partial-failure contract the CLI documents.

For a project group root the result also has `projects`, one
`{ project, root, path, branch?, head?, detached, rules, setup? }` per member in
file order (`root` is the source repository). The top-level `branch` is set
only when every member ended on that branch, `detached` is true only when
every member is detached, `head` is absent, and `rules` is the outcome of the
group's own rules. Errors from one member are prefixed with its project path
and carry `details.project`. A Git repository whose `.workler` declares
projects fails with `CONFIG_INVALID`. A declared path that is missing, is not
a repository, or is reached through a symbolic link fails with
`NOT_A_GIT_REPO`; links are never followed. A group-level rule for `.workler` itself is CONFIG_INVALID: `add` copies the group's file into every group workspace.

The `.workler` [`setup` commands](/guide/setup) then run inside the finished
workspace unless `setup: false` is passed (what `add --no-setup` does). They
run after the locks are released, sequentially, through the platform
shell, with the workspace as `cwd` and `WORKLER_WORKSPACE`,
`WORKLER_WORKSPACE_PATH`, and `WORKLER_ROOT` added to `process.env`. A
`setup --if-missing <path>` line whose path exists in the workspace is
skipped: its result has `status: 'skipped'` and `ifMissing` set. One whose
command ran and created its path is recorded (`workler.setupOutput` in the
clone's git config, `.workler-setup.json` in a group workspace folder) for
the local-data guard of `remove`, together with the identity of the entry it
made, so it counts only while that entry is still there; the record is
dropped when the path is missing and the command runs again, until that run
succeeds. The
caller's package-manager variables (`npm_*`, `pnpm_*`, `yarn_*`,
`INIT_CWD`, in that lowercase spelling) are not passed on; everything else in
`process.env` is, including uppercase installer settings such as
`NPM_CONFIG_REGISTRY`.

By default (`setupStdio: 'inherit'`) the commands share the caller's stdin,
stdout and stderr, as the CLI does; `setupStdout: 'stderr'` routes their
stdout to stderr (the CLI does this when its stdout is not a terminal). With
`setupStdio: 'pipe'` nothing reaches the caller's streams: stdin is closed,
and each command's stdout and stderr are captured, handed to
`onSetupOutput(chunk, stream, command, index)` (`stream` is `'stdout'` or
`'stderr'`; once per stream that produced output, after the command exits,
since the API is synchronous) and kept on its result as `stdout` and
`stderr`. Up to 64 MiB per stream is kept; a command that writes more is
stopped and reported as a failure. `onSetupOutput` requires
`setupStdio: 'pipe'`, and `setupStdout: 'stderr'` cannot be combined with
it (`INVALID_OPTIONS`). `onSetupCommand(command, index,
total)` fires before each command starts, and `onSetupSkip(command, index,
total)` instead of it for a skipped one. The first failing command throws
`SETUP_COMMAND_FAILED` with `details` `{ name, path, command, exitCode?,
signal?, index, commandCount, results, project?, workspace }`; the workspace
is complete and stays in place, so the caller can retry with
`setupWorkspace()`. `details.workspace` is a `CreatedWorkspace`: the
`CreateWorkspaceResult` as far as it got (`name`, `path`, `branch`,
`head`, `detached`, `copyLinks`, `rules`, and `projects` for a group,
each without `setup`), so a consumer knows what exists and where. The
result's `setup` is `{ commandCount, results }`.

In a project group every member's commands run first, inside its clone and
read from its source repository (`WORKLER_ROOT` is the source, and
`WORKLER_GROUP`, `WORKLER_GROUP_WORKSPACE_PATH`, and `WORKLER_PROJECT` are
set), in file order; then the group's own commands run in the workspace
folder (`WORKLER_ROOT` is the group root, `WORKLER_PROJECT` is unset).
`onProjectSetup(project, commandCount, skipped?)` fires before each member's
run and `onGroupSetup(commandCount)` before the group's. Each member's
outcome lands in `projects[i].setup`, the group's own in `setup`. A member's
failure is prefixed with its project path and carries `details.project`;
nothing after it runs.

### `setupWorkspace(root, name, options?): SetupWorkspaceResult`

Same as [`workler setup <name>`](/reference/cli/setup): re-runs the `setup`
commands of `root`'s `.workler` in the existing workspace `name`, with the
same options and the same `SETUP_COMMAND_FAILED` contract as
`createWorkspace`, except that `details.workspace` is only set by
`createWorkspace`. Returns `{ name, path, root, setup, projects?, project? }`
where `setup` is `{ commandCount, results }` and each result is
`{ command, status: 'ok' | 'skipped', ifMissing?, stdout?, stderr? }` (the
streams only with `setupStdio: 'pipe'`); a `commandCount` of `0`
means `.workler` declares no commands. Refuses `main` (`MAIN_WORKSPACE`)
and unknown names (`WORKSPACE_NOT_FOUND`). Does not take the project lock
(see [Locking](#locking)).

Under a project group, `name` may address one member (`"feat/projects/api"`):
only that member's commands run, `path` is the clone, `root` its source
repository, and `project` the declared path; `onProjectSetup` fires for it
as in `createWorkspace`, `onGroupSetup` does not. Addressing the whole workspace
runs every member's commands and then the group's own; `projects` then lists
one `{ project, root, path, setup?, skipped? }` per declared project, where
`skipped` says why a member that is not a usable clone, or whose source is
missing, not a repository, or behind a symbolic link, was left alone.
Addressing such a member directly throws `WORKSPACE_NOT_FOUND` or
`NOT_A_GIT_REPO` instead.

Types: `CreatedWorkspace`, `SetupOptions`, `WorkspaceSetupOptions`, `SetupOutcome`,
`SetupCommandResult`, `SetupTarget`, `SetupWorkspaceResult`,
`WorkspaceSetupOutcome`, `MemberSetupResult`, and `SetupCommand`
(`{ command, ifMissing?, raw }`, also the `setup` array of a `WorkspacePlan`
and of each `MemberPlan`).

### `planWorkspaceCreation(root, options): WorkspacePlan`

The read-only planning half of `createWorkspace` (what `add --dry-run`
prints): the resolved target path, the checkout plan, the `setup` commands
that would run (in order), and any warnings. Nothing is created. For a
project group `checkout` is absent, `projects` holds one
`{ project, root, target, checkout, setup }` per member, and `setup` is the
group's own commands.

### `listWorkspaces(root): WorkspaceInfo[]`

The main project plus every entry under `.worktrees/`, including broken
ones: `{ name, path, isMain, isClone, broken?, branch?, head?,
shortHead?, detached, clean?, projects? }`. `clean` uses the same guard as `remove`
(untracked and ignored files count as dirty, except, in a workspace, what the project's `.workler` produces: copy and link destinations that are what `apply` makes of their source (a link to it, or a copy with its content, the source reached through real directories), and `setup --if-missing` paths a guarded command created there, per the workspace's record; in the main checkout everything counts, since the rules' sources live there, not their outputs; an empty `.worktrees/`, Workler's own lock directory, does not count either), so for a non-main workspace
`clean === true` means removable without force.

Under a project group every entry has `projects`, one `{ project, path,
isClone, broken?, branch?, head?, shortHead?, detached, clean? }` per
declared project (for `main`, the source repositories). A member's `isClone` is true only for its usable clone, so it is false whenever that member's `broken` is set. The entry's own
`isClone` is true for every recognized group workspace, even one left behind
with no member cloned yet; `branch` is set only when every member is on it, `clean` only when every
member is clean and the workspace folder holds nothing but the members (real directories reached through real directories that carry the recorded member identity; a symbolic link or file at a member's path, or at any folder on the way to it, is local data, and so is a repository that is not the recorded clone) plus an unchanged `.workler` copy (a regular file; a symbolic link in its place is local data), and
`broken` joins the reasons of every broken or missing member.

### `resolveWorkspacePath(root, name): string`

Absolute path of a workspace by name (`"main"` resolves to the root).
Throws `WORKSPACE_NOT_FOUND` for unknown names. Under a project group,
`"<name>/<project path>"` resolves one member of the workspace
(`"feat/projects/api"`, `"main/tools"`); an undeclared project throws
`WORKSPACE_NOT_FOUND` too.

### `removeWorkspace(root, name, { force? }): RemoveWorkspaceResult`

Same as `workler remove`: refuses to remove `main`, and refuses a
workspace with local data (uncommitted changes, untracked and ignored files;
not the copy/link destinations of the project's `.workler` that still
match their source, nor the `setup --if-missing` paths its commands created, which
`apply` and `setup` regenerate) unless
`force` is set — that failure is `WORKSPACE_DIRTY`. Its `details.entries`
lists what was found in a plain workspace (`{ path, kind }`, `kind` one of
`uncommitted`, `untracked`, `ignored`, at most eleven; absent when `git status`
failed); for a project group, `details.reasons` holds one line per reason.

### `groupRefNamespace(groupRoot): string`

Where `workler branch-sync` run at a [project group](/guide/project-groups)
root mirrors a member clone's branches inside its source repository:
`refs/workler-group/<group>/<workspace>/<branch>`, with `<group>` the group
folder's name plus a short hash of its canonical path. Use it to inspect the
mirrors of one group; a repository that belongs to two groups has one such
namespace per group.

## Locking

The mutating API operations (`initProject`, `createWorkspace`,
`removeWorkspace`) and mutating CLI operations (`add`, `apply`, `remove`,
`fetch`, `sync`, and `branch-sync`) take a per-project lock for their duration,
so mutating commands addressed to the same project root are serialized. Dry
runs and read-only operations never lock. Setup commands run **outside** the
lock: `createWorkspace` releases it before the first command starts, and
`setupWorkspace` / `workler setup` never take it, so a long `pnpm install`
does not block sibling workspaces — nor does anything stop a concurrent
`removeWorkspace` of the workspace being set up.

- The lock is a JSON file at `<root>/.worktrees/.workler.lock`
  (`projectLockPath(root)` returns it) recording the holder's pid,
  hostname, operation, start time, and a unique ownership token.
- If the lock is already held, the operation fails immediately with
  `LockError` (`code: "LOCKED"`, with `lockPath` and `holder`). There is
  no built-in waiting — retry at whatever cadence suits the caller.
- **Stale-lock recovery:** a lock whose holder can be proven dead is
  reclaimed automatically — same hostname and the pid no longer exists,
  or an unreadable/torn lock file is at least 30 seconds old. Fresh malformed
  files are protected because another process may still be writing them. A
  lock from a different host is never reclaimed (liveness cannot be checked);
  delete the file manually
  if you know the process is gone.
- Locks are scoped per project root: nested projects lock their own
  `.worktrees/`, independent of the parent. A parent `fetch`, `sync`, or
  `branch-sync` also touches its child repositories, so do not run one
  concurrently with a mutation addressed directly to a nested project.
- A project group locks its own `.worktrees/`. `remove <name>` and
  `apply <name>` hold that lock while they delete or rewrite the workspace,
  so every mutating operation rooted inside it (`add`, `remove`, `apply`,
  `fetch`, `sync`, `branch-sync`, `init`, and the API functions behind them)
  takes the group's lock first and then its own. That holds for a member
  clone, marked or not (a clone that an interrupted `add` left behind is
  recognized by its location and remotes), for the workspace folder itself
  when `add` runs there (a nested group), and it continues up through every
  enclosing group. A bare `apply` inside a member clone takes the group's
  locks and the source repository's, not the clone's own: it changes the
  clone itself from the source's rules, not the clone's `.worktrees/`. A
  workspace nested deeper, inside a member clone's own `.worktrees/`, follows
  the nested-project rule above.
- `add`, `apply`, `fetch`, `sync`, and `branch-sync` at a group root also
  take the lock of every usable source repository, in declared order: `add`
  clones from the sources and applies their rules, `apply` reads their rules
  and copies from them, and the other three fetch into, fast-forward, and
  write mirrored refs into them. A `sync` or `apply` run inside a source
  repository therefore fails with `LOCKED` while the group's is running, and
  the other way round. Dry runs take no locks. A source that is missing, not
  a repository, or behind a symbolic link is skipped and never locked.
