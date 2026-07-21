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

## Functions

### `initProject(root): InitResult`

Same as the optional `workler init` helper: creates `.workler` (if missing),
`.worktrees/`, marks the repository with `workler.*` Git config, and adds
`.worktrees/` to `.git/info/exclude` (or `.gitignore` for non-Git roots).
Ordinary Git repositories do not need initialization. Idempotent;
the result reports whether the config file was created.

### `inspectProject(root): ProjectInfo`

Non-throwing inspection: `{ root, exists, gitRepo, marked,
configFileExists, workspacesDirExists, initialized, parent }`. Every Git
repository is immediately usable and reports `initialized: true`; a non-Git
directory does so only when `.workler` explicitly marks it. `parent` is set
when the root is itself a managed workspace (nested workspaces).

### `createWorkspace(root, options): CreateWorkspaceResult`

Same semantics as [`workler add`](/reference/cli/add). `options`:
`{ name, base?, branch?, checkout?, force? }` with the exact `add` rules.
`checkout` is exclusive, while `base` and `branch` may be combined to create
an explicitly named branch from an explicit start point; `name` alone creates
a new branch from `HEAD`. Optional `onProgress(message)` and
`onRuleResult(result)` callbacks stream what the CLI would print. The
result carries `path`, `branch` (undefined when detached), `head`,
`detached`, and the structured copy/link `rules` outcome.

`.workler` copy/link rules are applied exactly as with the CLI, including
conflict detection and `force` replacement. If setup fails after the
clone was created (bad config, rule conflict), the error is
`SETUP_FAILED` and the clone is left in place for inspection — the same
partial-failure contract the CLI documents.

### `planWorkspaceCreation(root, options): WorkspacePlan`

The read-only planning half of `createWorkspace` (what `add --dry-run`
prints): the resolved target path, the checkout plan, and any warnings.
Nothing is created.

### `listWorkspaces(root): WorkspaceInfo[]`

The main project plus every entry under `.worktrees/`, including broken
ones: `{ name, path, isMain, isClone, broken?, branch?, head?,
shortHead?, detached, clean? }`. `clean` uses the same guard as `remove`
(untracked and ignored files count as dirty), so for a non-main workspace
`clean === true` means removable without force.

### `resolveWorkspacePath(root, name): string`

Absolute path of a workspace by name (`"main"` resolves to the root).
Throws `WORKSPACE_NOT_FOUND` for unknown names.

### `removeWorkspace(root, name, { force? }): RemoveWorkspaceResult`

Same as `workler remove`: refuses to remove `main`, and refuses a
workspace with uncommitted changes (including untracked and ignored files) unless
`force` is set — that failure is `WORKSPACE_DIRTY`.

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
