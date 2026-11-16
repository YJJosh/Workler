import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = '.workler';
export const WORKSPACES_DIR = '.worktrees';
export const MAIN_WORKSPACE_NAME = 'main';
export const PACKAGE_NAME = 'workler';

/**
 * The `setup --if-missing` paths a workspace's guarded commands created, so
 * `remove` can tell them from user data. Multi-valued git config key in a
 * clone; group workspace folders have no git config and use the file.
 */
export const SETUP_OUTPUT_KEY = 'workler.setupOutput';
export const SETUP_RECORD_FILE = '.workler-setup.json';

/** Remote back to the checkout a workspace was cloned from; `origin` stays the real upstream. */
export const ROOT_REMOTE = 'workler-root';

/**
 * `branch-sync` mirrors into the source as refs/workler/<workspace>/<branch>.
 * Group workspaces use their own namespace so a repository workspace and a
 * group workspace with the same name never prune each other's refs.
 */
export const WORKSPACE_REFS = 'refs/workler';
export const GROUP_WORKSPACE_REFS = 'refs/workler-group';

// dist/constants.js sits one level below the package root in dev and published layouts.
export const VERSION: string = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
).version;
