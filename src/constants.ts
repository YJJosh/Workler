import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = '.workler';
export const WORKSPACES_DIR = '.worktrees';
export const MAIN_WORKSPACE_NAME = 'main';
export const PACKAGE_NAME = 'workler';

// Where a workspace records the `setup --if-missing` paths its guarded
// commands created, so `remove` can tell an installed node_modules from a
// folder a user made at the same path: a multi-valued key in the git config
// of a repository workspace or member clone (next to workler.root), and a
// file next to the .workler copy in a group workspace folder, which has no
// git config.
export const SETUP_OUTPUT_KEY = 'workler.setupOutput';
export const SETUP_RECORD_FILE = '.workler-setup.json';

// The remote every workspace carries back to the checkout it was cloned from.
// `add` creates it and `branch-sync` fetches through it; `origin` is reserved
// for the main project's real upstream (or absent when it has none).
export const ROOT_REMOTE = 'workler-root';

// Where `branch-sync` mirrors a workspace's branches inside the project it
// was cloned from: refs/workler/<workspace>/<branch>. A project group's
// workspaces mirror into each member's source repository under a separate
// namespace, so a repository's own workspace named "feat" and a group
// workspace named "feat" never prune each other's refs.
export const WORKSPACE_REFS = 'refs/workler';
export const GROUP_WORKSPACE_REFS = 'refs/workler-group';

// Read at runtime so `npm version` bumps cannot drift from what `help`
// reports. This file compiles to dist/constants.js, one level below the
// package root in both the dev and the published layout.
export const VERSION: string = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
).version;
