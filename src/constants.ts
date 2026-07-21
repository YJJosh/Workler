import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = '.workler';
export const WORKSPACES_DIR = '.worktrees';
export const MAIN_WORKSPACE_NAME = 'main';
export const PACKAGE_NAME = 'workler';

// The remote every workspace carries back to the checkout it was cloned from.
// `add` creates it and `branch-sync` fetches through it; `origin` is reserved
// for the main project's real upstream (or absent when it has none).
export const ROOT_REMOTE = 'workler-root';

// Read at runtime so `npm version` bumps cannot drift from what `help`
// reports. This file compiles to dist/constants.js, one level below the
// package root in both the dev and the published layout.
export const VERSION: string = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
).version;
