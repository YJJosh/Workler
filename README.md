# Workler

Workler creates full, isolated Git clones under `.worktrees/`. Each workspace has its own repository state, with optional copy and link rules for sharing local dependencies or copying untracked configuration, and setup commands that run once the files are in place.

[Documentation](https://yjjosh.github.io/Workler/) · [Getting started](https://yjjosh.github.io/Workler/guide/getting-started) · [CLI reference](https://yjjosh.github.io/Workler/reference/cli/) · [API reference](https://yjjosh.github.io/Workler/reference/api)

## Install

Workler requires Node.js 18 or newer and Git.

```sh
npm install -g workler
workler help
```

## Quick start

Create and enter a workspace from any Git repository—no initialization or configuration file is required:

```sh
workler add feature-a
cd "$(workler path feature-a)"
```

This creates `.worktrees/feature-a` as an independent clone and checks out a new `feature-a` branch.

If a workspace needs local files or a setup step, add an optional `.workler` file before creating it:

```txt
link node_modules
copy .env
setup --if-missing node_modules pnpm install
```

Setup commands run in the new workspace after the rules; like a package manager's lifecycle scripts, they run whatever the repository's `.workler` says, so review that file in a project you do not know, and pass `--no-setup` (or set `WORKLER_NO_SETUP=1`) to clone without running them. A `--if-missing` line is skipped while its path exists, so the install only runs when the link found nothing to point at. That pairing fits a project with one `node_modules`. In a pnpm workspace every package keeps its own, and in a yarn workspace the packages are linked back to their source, so a root link points into the main checkout either way; there, leave out the `link` line and use the project's own installer as a plain line, `setup pnpm install` or `setup yarn install`, which the package manager's cache keeps cheap. `workler init` can create a commented starter file, but it is not required. Apply new rules to an existing workspace with `workler apply feature-a`, and re-run its setup commands with `workler setup feature-a`.

For a workspace that shares nothing, `workler add feature-b --copy-links` copies what the `link` rules would symlink, and `workler apply feature-a --copy-links` converts an existing workspace's links into copies.

Useful commands:

```sh
workler list                 # list workspaces
workler status               # show branch and working-tree state
workler sync                 # safely fast-forward workspaces
workler remove feature-a     # remove a workspace
```

See the [CLI reference](https://yjjosh.github.io/Workler/reference/cli/) for every command and option.

## Highlights

- **Independent clones** — unlike `git worktree`, each workspace has its own Git metadata, branches, and fetch state.
- **Repeatable setup** — [copy and link rules](https://yjjosh.github.io/Workler/guide/rules) prepare local dependencies and untracked files, and [setup commands](https://yjjosh.github.io/Workler/guide/setup) run the rest, automatically.
- **Safe by default** — existing data is not overwritten without `--force`, and `--dry-run` previews changes.
- **Workspace coordination** — [status and sync commands](https://yjjosh.github.io/Workler/guide/sync) operate across all local clones without merging or rebasing.
- **Nested workflows** — [nested workspaces](https://yjjosh.github.io/Workler/guide/nested-workspaces) support parallel features and coding agents.
- **Project groups** — [several repositories in one folder](https://yjjosh.github.io/Workler/guide/project-groups) become one workspace: list them in `.workler` and a single `workler add` clones all of them, in the same layout.
- **Programmatic use** — the package includes a typed [JavaScript and TypeScript API](https://yjjosh.github.io/Workler/reference/api).

## License

[MIT](LICENSE)
