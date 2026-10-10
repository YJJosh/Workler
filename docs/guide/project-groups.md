# Project groups (several repositories)

A **project group** is a plain folder that holds several Git repositories. Its `.workler` lists them with `project <path>` lines, and `workler add` run in that folder clones every listed repository into one workspace directory, in the same layout:

```txt
root/                          a plain folder, not a Git repository
  .workler                     project projects/api
                               project projects/web
                               project tools
  projects/
    api/                       a Git repository, with its own optional .workler
    web/
  tools/
  .worktrees/
    feat/                      made by `workler add feat`, run in root/
      .workler                 copy of root/.workler
      projects/
        api/                   clone of root/projects/api, on branch feat
        web/                   clone of root/projects/web, on branch feat
      tools/                   clone of root/tools, on branch feat
```

Nothing changes for the repositories themselves. Each one keeps its own `.workler`, its own `.worktrees/`, and works exactly as before when used on its own. The group only decides where a set of clones lives and lets you manage that set as one unit.

## Setting up a group

```bash
cd root
workler init
```

In a folder that is not a Git repository, `init` looks for repositories directly below it and one level deeper (`projects/api`), skipping hidden directories, `node_modules`, and linked `git worktree` checkouts, and writes a `project` line for each:

```txt
created .workler
project projects/api
project projects/web
project tools
ready   .worktrees
ignored .worktrees/ in .gitignore
```

You can also write the file by hand. A repository added later is never included silently: a second `init` prints a hint with the lines to add. The rules for `project` paths are the ones for [rule paths](/reference/configuration#path-rules), plus two of their own: projects cannot be nested in each other, and a group-level `copy`/`link` rule cannot reach into a project (that rule belongs in the project's own `.workler`).

A group root must be a plain folder. A Git repository whose `.workler` declares projects is rejected by `add` with a clear message rather than half-honored.

## Creating a group workspace

```bash
cd root
workler add feat
```

Everything is validated first, for every member: the branch or ref, the rules, and that each declared path really is a repository. If any member fails, nothing is cloned. Then, per project in file order: clone, branch, mark the clone, apply that project's own rules. Finally the group's own rules (if its `.workler` has any) are applied to the workspace folder itself, next to the clones.

```text
project projects/api
cloning /path/to/root/projects/api
     to /path/to/root/.worktrees/feat/projects/api
create branch feat from HEAD
linked node_modules
project projects/web
...
group rules
copied .env.shared
done   feat
path   /path/to/root/.worktrees/feat
```

The [branch options of `add`](/reference/cli/add#branch-behavior) apply to every member:

| Invocation | In every member |
| --- | --- |
| `workler add feat` | New branch `feat` from that repository's `HEAD`. Fails if any member already has `feat`. |
| `workler add feat main` | New branch `feat` from `main` (the ref must exist in every member). |
| `workler add exp --branch topic` | `topic` checked out where it exists, created from `HEAD` elsewhere. |
| `workler add review --checkout v1.2` | The tag or branch checked out, detached where it is not a branch. |

`--copy-links`, `--force`, and `--dry-run` work as usual; `--dry-run` prints the plan per project.

A failure after cloning started leaves the partial workspace in place: [`workler list`](/reference/cli/list) shows it as `incomplete`, [`workler status`](/reference/cli/status) names the missing member, and `workler remove feat --force` cleans it up.

## What a member clone is

Each clone inside the workspace is an ordinary Workler workspace **of its source repository**:

- Its rules come from the source's `.workler`, and `link` targets point back into the source (`feat/projects/api/node_modules` links to `root/projects/api/node_modules`).
- Its `workler-root` remote points at the source, so [`branch-sync`](/reference/cli/branch-sync) works between the two.
- Bare `workler apply` inside it refreshes it from the source.
- It additionally records its group in Git config (`workler.group`, `workler.groupProject`), see [Generated files](/reference/generated-files#in-a-project-group).

Because the layout mirrors the root, relative paths between projects keep working: a script in `tools` that reaches `../projects/api` finds the clone of `api` inside the workspace.

The clone only contains committed files, so a source repository's own `.worktrees/` never ends up in a group workspace.

## Three levels of workspaces

All three coexist, and each level only ever lists its own workspaces:

| Where you run `workler add` | What you get |
| --- | --- |
| In a repository: `root/projects/api` | A workspace of that repository under `root/projects/api/.worktrees/`, exactly as without a group. |
| In the group root: `root` | A group workspace under `root/.worktrees/` holding one clone per project. |
| In a member clone: `root/.worktrees/feat/projects/api` | A nested workspace of that clone, under its own `.worktrees/`, like any [nested workspace](/guide/nested-workspaces). |
| In a group workspace: `root/.worktrees/feat` | A nested **group** workspace: the copied `.workler` makes the workspace folder a group root of its own. |

```bash
cd "$(workler path feat/projects/api)" && workler add agent-1   # nested, api only
cd "$(workler path feat)" && workler add agent-2                # nested, all projects
```

## Addressing one member

Wherever a command takes a workspace name, `<name>/<project path>` names one member of a group workspace, and `main/<project path>` names a source repository:

```bash
workler path feat/projects/api          # the clone of api inside feat
wcd feat/projects/api                   # with the shell helper
workler apply feat/projects/api         # re-apply api's rules to that clone only
git -C "$(workler path main/tools)" log -1
```

`status`, `fetch`, `sync`, and `branch-sync` label every row the same way.

## Commands at a group root

| Command | At a group root |
| --- | --- |
| `list` | One line per workspace. The branch column shows the branch when every member is on it, `mixed` when they differ, `detached` when no member is on a branch, `incomplete` when a member is missing or broken. |
| `status`, `fetch`, `sync` | One row per member repository, including the sources as `main/<project>`. Per-row behavior is unchanged. |
| `branch-sync` | Per member, against its source repository. Mirrors land in the source under `refs/workler-group/<name>/<branch>`, a separate namespace from the source's own workspaces, so a repository's own `feat` workspace and the group's `feat` workspace never prune each other's refs. |
| `apply <name>` | Every cloned member from its source repository, then the group's own rules. A member that was never cloned is skipped. `apply --all` and bare `apply` inside the workspace folder do the same. |
| `remove <name>` | Refuses unless every member is clean (untracked and ignored files included) and the workspace folder holds nothing but the members and the `.workler` copy. Files from group-level `copy` rules count as local data, like a copied `.env` inside a clone does. `--force` removes everything. |

## Limits

- The root is a plain folder. A group that is itself a repository is not supported.
- Projects are listed explicitly, one `project` line each; there are no globs.
- Every member gets the same branch options; a workspace with only some of the projects is not supported.
- A repository that belongs to two groups shares one `refs/workler-group/<name>/` namespace per workspace name. Use different workspace names in the two groups.
