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
  `CONFIG_INVALID`, `RULE_CONFLICT`, `SETUP_FAILED`, and `LOCKED`.
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
holding both quote characters, a backslash, or a line break) as `unwritableProjects`.

### `inspectProject(root): ProjectInfo`

Non-throwing inspection: `{ root, exists, gitRepo, marked,
configFileExists, workspacesDirExists, initialized, parent, projects,
isGroup, configError?, memberOf? }`. Every Git repository is immediately
usable and reports `initialized: true`; a non-Git directory does so only when
`.workler` explicitly marks it. `parent` is set when the root is itself a
managed workspace (nested workspaces), or a group workspace folder (then it
is the group root). `projects` lists the declared `project` paths of a group
in file order (always empty for a Git repository) and `isGroup` is true when
there are any. `configError` carries the parse error when `.workler` cannot
be read. `memberOf` is `{ group, workspace, project }` for a member clone of
a group workspace.

### `discoverProjects(root): string[]`

Git repositories directly below a folder or one level deeper, as portable
relative paths in sorted order — what `initProject` declares in a non-Git
folder. Hidden directories, `node_modules`, and linked `git worktree`
checkouts are skipped.

### `createWorkspace(root, options): CreateWorkspaceResult`

Same semantics as [`workler add`](/reference/cli/add). `options`:
`{ name, base?, branch?, checkout?, force?, copyLinks? }` with the exact `add` rules.
`checkout` is exclusive, while `base` and `branch` may be combined to create
an explicitly named branch from an explicit start point; `name` alone creates
a new branch from `HEAD`. Optional `onProgress(message)` and
`onRuleResult(result)` callbacks stream what the CLI would print. The
result carries `path`, `branch` (undefined when detached), `head`,
`detached`, `copyLinks`, and the structured copy/link `rules` outcome.

`copyLinks: true` is `add --copy-links`: `link` rules are applied as
independent copies, and their results carry `copiedLink: true` while
`action` stays `'link'`.

`.workler` copy/link rules are applied exactly as with the CLI, including
conflict detection and `force` replacement. If setup fails after the
clone was created (bad config, rule conflict), the error is
`SETUP_FAILED` and the clone is left in place for inspection — the same
partial-failure contract the CLI documents.

For a project group root the result also has `projects`, one
`{ project, root, path, branch?, head?, detached, rules }` per member in
file order (`root` is the source repository). The top-level `branch` is set
only when every member ended on that branch, `detached` is true only when
every member is detached, `head` is absent, and `rules` is the outcome of the
group's own rules. Errors from one member are prefixed with its project path
and carry `details.project`. A Git repository whose `.workler` declares
projects fails with `CONFIG_INVALID`. A declared path that is missing, is not
a repository, or is reached through a symbolic link fails with
`NOT_A_GIT_REPO`; links are never followed. A group-level rule for `.workler` itself is CONFIG_INVALID: `add` copies the group's file into every group workspace.

### `planWorkspaceCreation(root, options): WorkspacePlan`

The read-only planning half of `createWorkspace` (what `add --dry-run`
prints): the resolved target path, the checkout plan, and any warnings.
Nothing is created. For a project group `checkout` is absent and `projects`
holds one `{ project, root, target, checkout }` per member.

### `listWorkspaces(root): WorkspaceInfo[]`

The main project plus every entry under `.worktrees/`, including broken
ones: `{ name, path, isMain, isClone, broken?, branch?, head?,
shortHead?, detached, clean?, projects? }`. `clean` uses the same guard as `remove`
(untracked and ignored files count as dirty), so for a non-main workspace
`clean === true` means removable without force.

Under a project group every entry has `projects`, one `{ project, path,
isClone, broken?, branch?, head?, shortHead?, detached, clean? }` per
declared project (for `main`, the source repositories). The entry's own
`isClone` is true for every recognized group workspace, even one left behind
with no member cloned yet; `branch` is set only when every member is on it, `clean` only when every
member is clean and the workspace folder holds nothing but the members (real directories reached through real directories; a symbolic link or file at a member's path, or at any folder on the way to it, is local data) plus an unchanged `.workler` copy (a regular file; a symbolic link in its place is local data), and
`broken` joins the reasons of every broken or missing member.

### `resolveWorkspacePath(root, name): string`

Absolute path of a workspace by name (`"main"` resolves to the root).
Throws `WORKSPACE_NOT_FOUND` for unknown names. Under a project group,
`"<name>/<project path>"` resolves one member of the workspace
(`"feat/projects/api"`, `"main/tools"`); an undeclared project throws
`WORKSPACE_NOT_FOUND` too.

### `removeWorkspace(root, name, { force? }): RemoveWorkspaceResult`

Same as `workler remove`: refuses to remove `main`, and refuses a
workspace with uncommitted changes (including untracked and ignored files) unless
`force` is set — that failure is `WORKSPACE_DIRTY`.

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
runs and read-only operations never lock.

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
- A project group locks its own `.worktrees/`, also for a bare `apply` run
  inside a member clone: the clone changes under the group's lock, not under
  its source repository's. Its source repositories are
  only read by `createWorkspace`, so they are not locked; `branch-sync` at a
  group root does write into them (mirrored refs), so do not run it
  concurrently with a `branch-sync` addressed to a member repository.
