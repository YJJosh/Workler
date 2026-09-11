# Workler

Workler creates full, isolated Git clones under `.worktrees/`. Each workspace has its own repository state, with optional copy and link rules for sharing local dependencies or copying untracked configuration.

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

If a workspace needs local files, add an optional `.workler` file before creating it:

```txt
link node_modules
copy .env
```

`workler init` can create a commented starter file, but it is not required. Apply new rules to an existing workspace with `workler apply feature-a`.

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
- **Repeatable setup** — [copy and link rules](https://yjjosh.github.io/Workler/guide/rules) prepare local dependencies and untracked files automatically.
- **Safe by default** — existing data is not overwritten without `--force`, and `--dry-run` previews changes.
- **Workspace coordination** — [status and sync commands](https://yjjosh.github.io/Workler/guide/sync) operate across all local clones without merging or rebasing.
- **Nested workflows** — [nested workspaces](https://yjjosh.github.io/Workler/guide/nested-workspaces) support parallel features and coding agents.
- **Programmatic use** — the package includes a typed [JavaScript and TypeScript API](https://yjjosh.github.io/Workler/reference/api).

## License

[MIT](LICENSE)
