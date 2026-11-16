import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = '.workler';
export const WORKSPACES_DIR = '.worktrees';
export const MAIN_WORKSPACE_NAME = 'main';
export const PACKAGE_NAME = 'workler';

/** Multi-valued git config key: `setup --if-missing` paths created in a clone, which `remove` does not count as user data. */
export const SETUP_OUTPUT_KEY = 'workler.setupOutput';
/** The same record for a group workspace folder, which has no git config. */
export const SETUP_RECORD_FILE = '.workler-setup.json';

/** Remote back to the checkout a workspace was cloned from; `origin` stays the real upstream. */
export const ROOT_REMOTE = 'workler-root';

/** `branch-sync` mirrors into the source as refs/workler/<workspace>/<branch>. */
export const WORKSPACE_REFS = 'refs/workler';
/** Own namespace, so a repository and a group workspace with the same name never prune each other's refs. */
export const GROUP_WORKSPACE_REFS = 'refs/workler-group';

// dist/constants.js sits one level below the package root in dev and published layouts.
export const VERSION: string = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
).version;
