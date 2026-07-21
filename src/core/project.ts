import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, MAIN_WORKSPACE_NAME, WORKSPACES_DIR } from '../constants';
import { WorklerError } from '../errors';
import { addLineIfMissing, canonicalPath } from '../fs-utils';
import { git, gitInfoExcludePath, gitMaybe, isGitTopLevel } from '../git';
import { withProjectLock } from '../lock';
import { parentProject } from '../workspaces';

// True when `dir` is itself the toplevel of a git repository (not merely
// inside one). The explicit-root API must never operate on an enclosing
// repository the caller did not name: `git clone --local <subdir>` would
// clone the enclosing repo.
export function isGitProjectRoot(dir: string): boolean {
  return isGitTopLevel(dir);
}

export interface ProjectInfo {
  // Absolute, resolved project root.
  root: string;
  // The root directory exists.
  exists: boolean;
  // root is the toplevel of a git repository.
  gitRepo: boolean;
  // git config workler.name/workler.root is set (init or add marked it).
  marked: boolean;
  configFileExists: boolean;
  workspacesDirExists: boolean;
  // Usable as a Workler project: any Git repository, or a non-Git directory
  // explicitly initialized with a .workler file.
  initialized: boolean;
  // Set when this project is itself a managed workspace: the immediate
  // parent project it was cloned from (nested workspaces).
  parent?: string;
}

export function inspectProject(rootInput: string): ProjectInfo {
  const root = path.resolve(rootInput);
  let exists = false;
  try {
    exists = fs.statSync(root).isDirectory();
  } catch (_) {
    exists = false;
  }

  if (!exists) {
    return {
      root,
      exists,
      gitRepo: false,
      marked: false,
      configFileExists: false,
      workspacesDirExists: false,
      initialized: false,
    };
  }

  const gitRepo = isGitProjectRoot(root);
  const marked =
    gitRepo &&
    Boolean(
      gitMaybe(root, ['config', '--local', '--get', 'workler.name']) ||
        gitMaybe(root, ['config', '--local', '--get', 'workler.root']),
    );
  const configFileExists = fs.existsSync(path.join(root, CONFIG_FILE));
  const workspacesDirExists = fs.existsSync(path.join(root, WORKSPACES_DIR));

  return {
    root,
    exists,
    gitRepo,
    marked,
    configFileExists,
    workspacesDirExists,
    initialized: gitRepo || configFileExists,
    parent: gitRepo ? parentProject(root) : undefined,
  };
}

// Shared explicit-root guard for the workspace operations.
export function requireProject(rootInput: string): ProjectInfo {
  const info = inspectProject(rootInput);
  if (!info.exists) {
    throw new WorklerError('ROOT_NOT_FOUND', `project root does not exist: ${info.root}`, { root: info.root });
  }
  if (!info.initialized) {
    throw new WorklerError(
      'NOT_INITIALIZED',
      `project root is neither a Git repository top level nor a directory with .workler: ${info.root}. ` +
        'Pass the Git repository root, or run `workler init` there first.',
      { root: info.root },
    );
  }
  return info;
}

export interface InitResult {
  root: string;
  configPath: string;
  // False when a .workler file already existed and was left untouched.
  configCreated: boolean;
  workspacesPath: string;
  gitRepo: boolean;
  // Where the ".worktrees/" ignore entry went: .git/info/exclude for a git
  // project, .gitignore otherwise.
  excludePath?: string;
  gitignorePath?: string;
}

export function initProject(rootInput: string): InitResult {
  const root = path.resolve(rootInput);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new WorklerError('ROOT_NOT_FOUND', `project root does not exist: ${root}`, { root });
  }

  return withProjectLock(root, 'init', () => {
    const configPath = path.join(root, CONFIG_FILE);
    const workspacesPath = path.join(root, WORKSPACES_DIR);

    let configCreated = false;
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, [
        '# Workler local workspace rules',
        '#',
        '# Syntax:',
        '#   link <path>  # symlink from workspace back to this project',
        '#   copy <path>  # copy into each workspace when applied',
        '#',
        '# Examples:',
        '# link node_modules',
        '# copy .env',
        '',
      ].join('\n'));
      configCreated = true;
    }

    fs.mkdirSync(workspacesPath, { recursive: true });

    const gitRepo = isGitProjectRoot(root);
    let excludePath: string | undefined;
    let gitignorePath: string | undefined;
    if (gitRepo) {
      git(root, ['config', '--local', 'workler.root', canonicalPath(root)]);
      git(root, ['config', '--local', 'workler.name', MAIN_WORKSPACE_NAME]);
      excludePath = gitInfoExcludePath(root);
      addLineIfMissing(excludePath, `${WORKSPACES_DIR}/`);
    } else {
      gitignorePath = path.join(root, '.gitignore');
      addLineIfMissing(gitignorePath, `${WORKSPACES_DIR}/`);
    }

    return { root, configPath, configCreated, workspacesPath, gitRepo, excludePath, gitignorePath };
  });
}
