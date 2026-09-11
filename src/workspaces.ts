import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, MAIN_WORKSPACE_NAME, PACKAGE_NAME, WORKSPACES_DIR } from './constants';
import { WorklerError } from './errors';
import { canonicalPath, pathsReferToSameLocation } from './fs-utils';
import { findGitTopLevel, gitMaybe, isGitTopLevel } from './git';
import type { Workspace } from './types';

// Discovers the nearest enclosing workler project from `startDir` (the CLI
// passes process.cwd(); the programmatic API takes explicit roots instead
// but exports this for callers that want CLI-style discovery).
export function findWorklerRoot(startDir: string): string {
  const cwd = path.resolve(startDir);

  // The nearest Git repository is a Workler project automatically; `.workler`
  // is optional and only supplies copy/link rules. Managed workspaces are
  // marked by `add`, so they win as their own roots and can host nested
  // workspaces. Never follow workler.root here — it points at the immediate
  // parent and would climb out of a successfully configured workspace.
  const gitRoot = findGitTopLevel(cwd);
  if (gitRoot) {
    const marked =
      gitMaybe(gitRoot, ['config', '--local', '--get', 'workler.name']) ||
      gitMaybe(gitRoot, ['config', '--local', '--get', 'workler.root']);
    if (marked) {
      return gitRoot;
    }

    // A clone left behind by a failed `add` is a Git repository but was never
    // marked. If it occupies <parent>/.worktrees/<name>, keep treating it as
    // part of the parent project so list/remove can recover it. An ordinary
    // unmarked Git repository anywhere else is immediately usable as a root.
    return workspaceParentOf(gitRoot) ?? gitRoot;
  }

  // Structural check for a non-repository directory below .worktrees/ (for
  // example a clone that failed before creating .git). Find the nearest
  // enclosing Git project so it can report and clean up the leftover.
  const structuralRoot = findRootFromWorkspacesPath(cwd);
  if (structuralRoot) {
    return structuralRoot;
  }

  // Preserve the existing non-Git setup supported by `init`: there a
  // `.workler` file is still the explicit project marker.
  const configRoot = findAncestorContaining(cwd, CONFIG_FILE);
  if (configRoot) {
    return configRoot;
  }

  throw new WorklerError(
    'ROOT_NOT_FOUND',
    `could not find a Git repository or .workler config. Run this command inside a Git repository, ` +
      `or run \`${PACKAGE_NAME} init\` first.`,
  );
}

// The immediate parent project of a managed workspace: workler.root as set
// by `add` (the checkout it was cloned from). Returns undefined for the main
// project, whose workler.root points at itself.
export function parentProject(root: string): string | undefined {
  const configured = gitMaybe(root, ['config', '--local', '--get', 'workler.root']);
  if (!configured) {
    return undefined;
  }
  const parent = canonicalPath(configured);
  if (pathsReferToSameLocation(parent, root) || !fs.existsSync(parent)) {
    return undefined;
  }

  // A managed workspace always lives directly under its recorded parent's
  // .worktrees directory. Do not trust a stale workler.root merely because a
  // different directory now exists at the recorded path.
  const workspaceParent = path.dirname(canonicalPath(root));
  if (!pathsReferToSameLocation(workspaceParent, path.join(parent, WORKSPACES_DIR))) {
    return undefined;
  }
  return parent;
}

function findAncestor(start: string, check: (dir: string) => string | undefined): string | undefined {
  let current = path.resolve(start);
  while (true) {
    const found = check(current);
    if (found !== undefined) {
      return found;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

// If repo sits at <parent>/.worktrees/<name> and <parent> is a Git project
// (or an explicitly configured non-Git project), return that parent.
function workspaceParentOf(repo: string): string | undefined {
  const workspacesDir = path.dirname(repo);
  if (path.basename(workspacesDir) !== WORKSPACES_DIR) {
    return undefined;
  }
  // Workler creates independent clones whose .git is a directory. A linked
  // `git worktree` uses a .git file and must remain an independent project,
  // never something Workler lists/removes as one of its own clones.
  if (!hasIndependentGitDirectory(repo)) {
    return undefined;
  }
  const parent = path.dirname(workspacesDir);
  if (isGitTopLevel(parent) || fs.existsSync(path.join(parent, CONFIG_FILE))) {
    return parent;
  }
  return undefined;
}

function findRootFromWorkspacesPath(start: string): string | undefined {
  return findAncestor(start, (dir) => {
    if (path.basename(dir) !== WORKSPACES_DIR) {
      return undefined;
    }
    const root = path.dirname(dir);
    return isGitTopLevel(root) || fs.existsSync(path.join(root, CONFIG_FILE)) ? root : undefined;
  });
}

function hasIndependentGitDirectory(repo: string): boolean {
  try {
    return fs.lstatSync(path.join(repo, '.git')).isDirectory();
  } catch (_) {
    return false;
  }
}

function findAncestorContaining(start: string, fileName: string): string | undefined {
  return findAncestor(start, (dir) => (fs.existsSync(path.join(dir, fileName)) ? dir : undefined));
}

// `.worktrees` is the containment boundary for clone creation and recursive
// removal. Following a symlink/junction here would let an apparently scoped
// add/remove mutate an arbitrary directory outside the project.
export function assertSafeWorkspacesDirectory(root: string): void {
  const workspacesPath = path.join(root, WORKSPACES_DIR);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(workspacesPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new WorklerError(
      'SETUP_FAILED',
      `refusing to use symlinked ${WORKSPACES_DIR} directory: ${workspacesPath}`,
      { root, path: workspacesPath },
    );
  }
  if (!stat.isDirectory()) {
    throw new WorklerError(
      'SETUP_FAILED',
      `${WORKSPACES_DIR} is not a directory: ${workspacesPath}`,
      { root, path: workspacesPath },
    );
  }
}

export function listWorkspaces(root: string): Workspace[] {
  const result: Workspace[] = [{ name: MAIN_WORKSPACE_NAME, path: root }];
  const workspacesPath = path.join(root, WORKSPACES_DIR);
  assertSafeWorkspacesDirectory(root);

  if (!fs.existsSync(workspacesPath)) {
    return result;
  }

  const entries = fs.readdirSync(workspacesPath, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    // Every workspace is an independent clone with its own .git directory.
    // Do NOT use `git rev-parse` here: .worktrees/ sits inside the main work
    // tree, so for a plain directory it would walk up, answer for the MAIN
    // repo, and report a phantom workspace named "main".
    const workspacePath = path.join(workspacesPath, entry.name);
    if (!hasIndependentGitDirectory(workspacePath)) {
      continue;
    }

    const name = gitMaybe(workspacePath, ['config', '--local', '--get', 'workler.name']) || entry.name;
    result.push({ name, path: workspacePath });
  }

  return result;
}

export function findWorkspace(root: string, name: string): Workspace {
  const workspace = listWorkspaces(root).find((item) => item.name === name);
  if (!workspace) {
    throw new WorklerError('WORKSPACE_NOT_FOUND', `workspace not found: ${name}`, { name });
  }
  return workspace;
}

export function validateWorkspaceName(name: string): void {
  if (!name || name === '.' || name === '..') {
    throw new WorklerError('INVALID_NAME', 'workspace name cannot be empty, . or ..');
  }
  if (name === MAIN_WORKSPACE_NAME) {
    throw new WorklerError('INVALID_NAME', `workspace name "${MAIN_WORKSPACE_NAME}" is reserved`);
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new WorklerError('INVALID_NAME', 'workspace name cannot contain path separators; use --branch for branch names with /');
  }
  if (/^[.]+$/.test(name)) {
    throw new WorklerError('INVALID_NAME', 'workspace name cannot be only dots');
  }
}
