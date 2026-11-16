import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, MAIN_WORKSPACE_NAME, PACKAGE_NAME, WORKSPACES_DIR } from './constants';
import { WorklerError } from './errors';
import { canonicalPath, pathsReferToSameLocation } from './fs-utils';
import { findGitTopLevel, git, gitConfigUnset, gitMaybe, hasIndependentGitDirectory, isGitTopLevel } from './git';
import { groupProjects, hasGroupConfig, inspectMember, isGroupWorkspaceDirectory, memberPath, sourceBrokenReason } from './groups';
import type { Workspace } from './types';

/**
 * The nearest enclosing Workler project, CLI-style.
 * @throws WorklerError ROOT_NOT_FOUND
 */
export function findWorklerRoot(startDir: string): string {
  const cwd = path.resolve(startDir);

  // Never follow workler.root here: it points at the parent and would climb
  // out of a workspace, which is its own root.
  const gitRoot = findGitTopLevel(cwd);
  if (gitRoot) {
    // A group folder may sit inside an unrelated outer repository (dotfiles,
    // a versioned home directory); the nearer group wins.
    const groupRoot = findGroupRootBelow(cwd, gitRoot);
    if (groupRoot) {
      return groupRoot;
    }

    const marked =
      gitMaybe(gitRoot, ['config', '--local', '--get', 'workler.name']) ||
      gitMaybe(gitRoot, ['config', '--local', '--get', 'workler.root']);
    if (marked) {
      return gitRoot;
    }

    // An unmarked clone under <parent>/.worktrees/ is left by a failed `add`;
    // it belongs to the parent so list and remove can clean it up.
    return workspaceParentOf(gitRoot) ?? gitRoot;
  }

  // Outside a repository: the nearest .workler, or a .worktrees/ boundary so
  // the project can clean up a clone that failed before creating .git.
  const explicitRoot = findNearestExplicitRoot(cwd);
  if (explicitRoot) {
    return explicitRoot;
  }

  throw new WorklerError(
    'ROOT_NOT_FOUND',
    `could not find a Git repository or .workler config. Run this command inside a Git repository, ` +
      `or run \`${PACKAGE_NAME} init\` first.`,
  );
}

/** The checkout a workspace was cloned from, or the group root of a group workspace folder. */
export function parentProject(root: string): string | undefined {
  return resolveParent(root).parent;
}

export interface ParentResolution {
  /** Undefined for a main project, and for a member clone whose source is broken. */
  parent?: string;
  /** The slot a member clone occupies, whether or not its source still exists. */
  memberOf?: GroupMembership;
}

export function resolveParent(root: string): ParentResolution {
  if (!isGitTopLevel(root)) {
    const group = groupWorkspaceParent(root)?.group;
    return group === undefined ? {} : { parent: group };
  }

  // A member lives at <group>/.worktrees/<name>/<project>, cloned from
  // <group>/<project>. A stale workler.root is not trusted just because some
  // directory exists at the recorded path.
  const configured = gitMaybe(root, ['config', '--local', '--get', 'workler.root']);
  const membership = groupMembership(root);
  if (membership) {
    const expectedLocation = memberPath(path.join(membership.group, WORKSPACES_DIR, membership.workspace), membership.project);
    const expectedParent = memberPath(membership.group, membership.project);
    if (
      !pathsReferToSameLocation(root, expectedLocation) ||
      (configured !== undefined && !pathsReferToSameLocation(canonicalPath(configured), expectedParent))
    ) {
      return {};
    }
    // A link or folder now at the source path must not become what a bare
    // `apply` refreshes from.
    const sourceUnusable = sourceBrokenReason(membership.group, membership.project);
    return sourceUnusable === undefined ? { parent: expectedParent, memberOf: membership } : { memberOf: membership };
  }

  if (!configured) {
    return {};
  }
  const parent = canonicalPath(configured);
  if (pathsReferToSameLocation(parent, root) || !fs.existsSync(parent)) {
    return {};
  }

  const workspaceParent = path.dirname(canonicalPath(root));
  if (!pathsReferToSameLocation(workspaceParent, path.join(parent, WORKSPACES_DIR))) {
    return {};
  }
  return { parent };
}

export interface GroupWorkspaceLocation {
  group: string;
  /** The directory name under .worktrees/. */
  name: string;
  path: string;
}

/** Undefined for clones and for directories that are not a group workspace. */
export function groupWorkspaceParent(dir: string): GroupWorkspaceLocation | undefined {
  const resolved = path.resolve(dir);
  const workspacesDir = path.dirname(resolved);
  if (path.basename(workspacesDir) !== WORKSPACES_DIR) {
    return undefined;
  }
  const group = path.dirname(workspacesDir);
  if (group === workspacesDir) {
    return undefined;
  }
  const projects = groupProjects(group);
  if (projects.length === 0 || !isGroupWorkspaceDirectory(resolved, projects)) {
    return undefined;
  }
  return { group, name: path.basename(resolved), path: resolved };
}

export interface GroupMembership {
  /** The group root (git config workler.group). */
  group: string;
  /** The group workspace name (workler.name). */
  workspace: string;
  /** The declared project path (workler.groupProject). */
  project: string;
}

// A clone an interrupted `add` did not finish marking is recognized by where
// it sits. resolveParent validates the result against the filesystem.
export function groupMembership(repo: string): GroupMembership | undefined {
  const group = gitMaybe(repo, ['config', '--local', '--get', 'workler.group']);
  const workspace = gitMaybe(repo, ['config', '--local', '--get', 'workler.name']);
  const project = gitMaybe(repo, ['config', '--local', '--get', 'workler.groupProject']);
  if (group && workspace && project) {
    return { group: canonicalPath(group), workspace, project };
  }
  return structuralMembership(repo);
}

// The nearest .worktrees/<name> above whose parent declares a project at
// exactly this path, if inspectMember accepts the clone. A broken group
// .workler declares nothing here; add reports it.
function structuralMembership(repo: string): GroupMembership | undefined {
  const resolved = path.resolve(repo);
  let current = resolved;
  while (true) {
    const workspacesDir = path.dirname(current);
    if (workspacesDir === current) {
      return undefined;
    }
    const group = path.dirname(workspacesDir);
    if (path.basename(workspacesDir) === WORKSPACES_DIR && group !== workspacesDir) {
      let projects: string[] = [];
      try {
        projects = groupProjects(group);
      } catch (error) {
        if (!(error instanceof WorklerError) || error.code !== 'CONFIG_INVALID') {
          throw error;
        }
      }
      const project = projects.find((candidate) => pathsReferToSameLocation(memberPath(current, candidate), resolved));
      if (project !== undefined && inspectMember(current, project).state === 'clone') {
        return { group: canonicalPath(group), workspace: path.basename(current), project };
      }
    }
    current = workspacesDir;
  }
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

function workspaceParentOf(repo: string): string | undefined {
  const workspacesDir = path.dirname(repo);
  if (path.basename(workspacesDir) !== WORKSPACES_DIR) {
    return undefined;
  }
  // A linked `git worktree` is never listed or removed as a Workler clone.
  if (!hasIndependentGitDirectory(repo)) {
    return undefined;
  }
  const parent = path.dirname(workspacesDir);
  if (isGitTopLevel(parent) || fs.existsSync(path.join(parent, CONFIG_FILE))) {
    return parent;
  }
  return undefined;
}

function findGroupRootBelow(start: string, gitRoot: string): string | undefined {
  let current = path.resolve(start);
  while (!pathsReferToSameLocation(current, gitRoot)) {
    if (hasGroupConfig(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
}

function findNearestExplicitRoot(start: string): string | undefined {
  return findAncestor(start, (dir) => {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) {
      return dir;
    }
    if (path.basename(dir) !== WORKSPACES_DIR) {
      return undefined;
    }
    const root = path.dirname(dir);
    return isGitTopLevel(root) || fs.existsSync(path.join(root, CONFIG_FILE)) ? root : undefined;
  });
}

/**
 * .worktrees bounds clone creation and recursive removal; a symlink or
 * junction there would let add or remove change a directory outside the project.
 * @throws WorklerError SETUP_FAILED
 */
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

  const projects = groupProjects(root);
  const entries = fs.readdirSync(workspacesPath, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const workspacePath = path.join(workspacesPath, entry.name);

    // A group workspace has no git config to record a name.
    if (projects.length > 0) {
      if (isGroupWorkspaceDirectory(workspacePath, projects)) {
        result.push({ name: entry.name, path: workspacePath });
      }
      continue;
    }

    // Not `git rev-parse`: for a plain directory it would answer for the main
    // repository and list a phantom "main".
    if (!hasIndependentGitDirectory(workspacePath)) {
      continue;
    }

    result.push({ name: workspaceName(workspacePath), path: workspacePath });
  }

  return result;
}

/** The name `add` recorded, or the directory name for an unmarked clone. */
export function workspaceName(workspacePath: string): string {
  return gitMaybe(workspacePath, ['config', '--local', '--get', 'workler.name']) || path.basename(workspacePath);
}

export function findWorkspace(root: string, name: string): Workspace {
  const workspace = listWorkspaces(root).find((item) => item.name === name);
  if (!workspace) {
    throw new WorklerError('WORKSPACE_NOT_FOUND', `workspace not found: ${name}`, { name });
  }
  return workspace;
}

// Remembered so a later plain `apply` keeps the copies instead of reporting
// each as a conflict with its link rule.
export function workspaceCopiesLinks(workspacePath: string): boolean {
  return gitMaybe(workspacePath, ['config', '--local', '--type=bool', '--get', 'workler.copyLinks']) === 'true';
}

export function setWorkspaceCopiesLinks(workspacePath: string, copyLinks: boolean): void {
  if (copyLinks) {
    git(workspacePath, ['config', '--local', 'workler.copyLinks', 'true']);
  } else {
    gitConfigUnset(workspacePath, 'workler.copyLinks');
  }
}

// The group folder has no git config, so its own rules' mode lives in every
// member under a separate key: switching one member's mode must not flip the group's.
export function groupWorkspaceCopiesLinks(members: string[]): boolean {
  return members.some(
    (member) => gitMaybe(member, ['config', '--local', '--type=bool', '--get', 'workler.groupCopyLinks']) === 'true',
  );
}

export function setGroupWorkspaceCopiesLinks(members: string[], copyLinks: boolean): void {
  for (const member of members) {
    if (copyLinks) {
      git(member, ['config', '--local', 'workler.groupCopyLinks', 'true']);
    } else {
      gitConfigUnset(member, 'workler.groupCopyLinks');
    }
  }
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
