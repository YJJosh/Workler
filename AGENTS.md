# AGENTS.md

Notes for coding agents working on the Workler source. For how to *use*
Workler in another project, see [`skills/workler/SKILL.md`](skills/workler/SKILL.md);
user documentation lives in [`docs/`](docs/).

## Setup and checks

- Node 18 or newer and npm (`package-lock.json` is committed). There are no
  runtime dependencies. The source is TypeScript compiled to CommonJS in
  `dist/`.
- Before opening a PR, run the checks CI runs:

  ```sh
  npm run check        # typecheck
  npm test             # builds, then runs every test file
  npm run smoke        # the built CLI starts
  npm pack --dry-run   # the files the npm package would contain
  npm run docs:build   # the docs site; dead links fail the build
  ```

  CI also checks the `dev:link` launcher and installs the packed tarball
  globally; repeat those (see `.github/workflows/ci.yml`) when you change
  `package.json`, its `bin` entry or `scripts/link-dev.cjs`.

- One test file: `npm run build && node --test test/names.test.js`.
- `npm run dev -- <args>` builds and runs the CLI. `npm run dev:link`
  installs the build as `devworkler`, leaving an installed `workler` alone.

## Tests

- Tests are plain JavaScript in `test/` and run against the built `dist/`,
  which is what package users get, so build before running one directly.
- CI runs on Ubuntu, macOS and Windows with Node 18, 20, 22 and 24. Code must
  only use Node 18 APIs, and paths must work on Windows.
- Use `makeTempDir` and `makeRepo` from `test/helpers.js`. They keep the
  OS spelling of temp paths on Windows, where `realpath` can turn a path into
  its 8.3 short form and break path comparisons.
- `test/run.js` lists the test files itself, because a `test/*.test.js` glob
  doesn't expand on Windows or on Node 18. New test files only need to end in
  `.test.js`.

## Layout

- `src/cli.ts`: entry point. `src/commands/`: one file per command, plus the
  help text in `help.ts`.
- `src/index.ts`: the public library API. `src/core/`: the operations it
  exports (create, remove, setup, list, project discovery).
- `src/rules.ts`: `.workler` copy and link rules. `src/setup.ts`: setup
  commands. `src/groups.ts`: project groups.
- `src/git.ts`, `src/multi-git.ts`: Git calls. `src/lock.ts`: the per-project
  lock. `src/fs-utils.ts`: links, copies and junctions.

## Rules that must hold

- The API takes an explicit project root and never reads `process.cwd()` or
  changes global state. Every function is synchronous. Domain failures throw
  `WorklerError` with a `code`.
- Anything that changes a project runs under `withProjectLock`
  (`src/lock.ts`), so concurrent calls get a `LockError` instead of racing.
- Git runs through `spawnSync` with an argument array and no shell. Only
  `.workler` setup commands run through a shell, by design.
- Rules never write outside the workspace, even through a symlinked or
  junctioned parent, and never replace an existing file without `--force`.
  On Windows, directory links are junctions so they work without Developer
  Mode.
- `remove` refuses while the workspace holds local files (changes,
  untracked or ignored data, except what `.workler` creates) unless `--force`
  is given (`src/git.ts`, `src/core/remove.ts`). It checks files only,
  not Git refs, so commits, stashes and tags that exist only in the clone are
  not detected; the skill tells agents how to keep them.

## Keep docs in sync

A change to a command, flag, rule or API also updates:

- `src/commands/help.ts` and `docs/reference/cli/<command>.md`;
- `docs/reference/configuration.md` for `.workler` syntax;
- `docs/reference/api.md` for the library API;
- `skills/workler/SKILL.md` if it changes how an agent should use Workler.

## Releases

- The docs site deploys automatically when a release is published, and a
  maintainer can also run **deploy docs** by hand. The skill installs from
  `main`.
- A maintainer runs the GitHub Actions in order: **1. Prepare version PR**
  opens the version bump, then after it is merged **prepare release** tags
  `main` and drafts the notes, and publishing that draft runs **npm publish**
  and **deploy docs**. Feature PRs don't change the version in `package.json`.
