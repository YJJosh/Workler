import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, MAIN_WORKSPACE_NAME, PACKAGE_NAME, WORKSPACES_DIR } from './constants';
import { WorklerError } from './errors';
import { canonicalPath, pathsReferToSameLocation } from './fs-utils';
import { findGitTopLevel, git, gitConfigUnset, gitMaybe, hasIndependentGitDirectory, isGitTopLevel } from './git';
import { groupProjects, hasGroupConfig, isGroupWorkspaceDirectory, memberPath } from './groups';
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
    // A project group is a plain folder, so it may sit inside some unrelated
    // outer repository (a dotfiles checkout, a home directory under version
    // control). A group root between the cwd and that repository is the
    // nearer project and wins.
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

    // A clone left behind by a failed `add` is a Git repository but was never
    // marked. If it occupies <parent>/.worktrees/<name>, keep treating it as
    // part of the parent project so list/remove can recover it. An ordinary
    // unmarked Git repository anywhere else is immediately usable as a root.
    return workspaceParentOf(gitRoot) ?? gitRoot;
  }

  // Outside any repository the nearest explicit marker wins: a `.workler`
  // file (the non-Git setup supported by `init`, and the copy `add` leaves in
  // every group workspace so it is its own root, like a marked clone), or
  // the .worktrees/ boundary of a project (a clone that failed before creating
  // .git, or a half-created group workspace) so the project can report and
  // clean up the leftover.
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

// The immediate parent project of a managed workspace: workler.root as set
// by `add` (the checkout it was cloned from). Returns undefined for the main
// project, whose workler.root points at itself. For a group workspace
// directory (not a clone) the parent is the group root.
export function parentProject(root: string): string | undefined {
  if (!isGitTopLevel(root)) {
    return groupWorkspaceParent(root)?.group;
  }

  const configured = gitMaybe(root, ['config', '--local', '--get', 'workler.root']);
  if (!configured) {
    return undefined;
  }
  const parent = canonicalPath(configured);
  if (pathsReferToSameLocation(parent, root) || !fs.existsSync(parent)) {
    return undefined;
  }

  // A member of a group workspace lives at <group>/.worktrees/<name>/<project>
  // and was cloned from <group>/<project>. Do not trust a stale workler.root
  // merely because a different directory now exists at the recorded path.
  const membership = groupMembership(root);
  if (membership) {
    const expectedLocation = memberPath(path.join(membership.group, WORKSPACES_DIR, membership.workspace), membership.project);
    const expectedParent = memberPath(membership.group, membership.project);
    if (!pathsReferToSameLocation(root, expectedLocation) || !pathsReferToSameLocation(parent, expectedParent)) {
      return undefined;
    }
    return parent;
  }

  // A managed workspace always lives directly under its recorded parent's
  // .worktrees directory.
  const workspaceParent = path.dirname(canonicalPath(root));
  if (!pathsReferToSameLocation(workspaceParent, path.join(parent, WORKSPACES_DIR))) {
    return undefined;
  }
  return parent;
}

export interface GroupWorkspaceLocation {
  // The group root the workspace belongs to.
  group: string;
  // The workspace name (its directory name under .worktrees/).
  name: string;
  path: string;
}

// If `dir` is a group workspace directory (<group>/.worktrees/<name> of a
// group root), return where it belongs. Undefined for clones and for
// directories that are not recognizably a group workspace.
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
  // The group root (workler.group).
  group: string;
  // The group workspace this clone is part of (workler.name).
  workspace: string;
  // The declared project path this clone was made from (workler.groupProject).
  project: string;
}

// What a member clone of a group workspace records about its group, or
// undefined for an ordinary workspace. Not validated against the filesystem;
// parentProject does that.
export function groupMembership(repo: string): GroupMembership | undefined {
  const group = gitMaybe(repo, ['config', '--local', '--get', 'workler.group']);
  const workspace = gitMaybe(repo, ['config', '--local', '--get', 'workler.name']);
  const project = gitMaybe(repo, ['config', '--local', '--get', 'workler.groupProject']);
  if (!group || !workspace || !project) {
    return undefined;
  }
  return { group: canonicalPath(group), workspace, project };
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
  // A linked `git worktree` uses a .git file and must remain an independent
  // project, never something Workler lists/removes as one of its own clones.
  if (!hasIndependentGitDirectory(repo)) {
    return undefined;
  }
  const parent = path.dirname(workspacesDir);
  if (isGitTopLevel(parent) || fs.existsSync(path.join(parent, CONFIG_FILE))) {
    return parent;
  }
  return undefined;
}

// The nearest group root strictly below `gitRoot` on the way up from `start`.
// `gitRoot` itself is a repository and therefore never a group.
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

  const projects = groupProjects(root);
  const entries = fs.readdirSync(workspacesPath, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const workspacePath = path.join(workspacesPath, entry.name);

    // A group workspace is a plain directory holding the member clones; it is
    // named by its directory, since there is no git config to record a name.
    if (projects.length > 0) {
      if (isGroupWorkspaceDirectory(workspacePath, projects)) {
        result.push({ name: entry.name, path: workspacePath });
      }
      continue;
    }

    // Every workspace is an independent clone with its own .git directory.
    // Do NOT use `git rev-parse` here: .worktrees/ sits inside the main work
    // tree, so for a plain directory it would walk up, answer for the MAIN
    // repo, and report a phantom workspace named "main".
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

// Whether the workspace materializes `link` rules as copies. Recorded in the
// workspace's own git config (next to workler.root/workler.name) so a later
// plain `apply` or `apply --all` keeps the copies instead of reporting every
// one of them as a conflict with its link rule.
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

// A group workspace folder is not a repository, so the copy-links mode of the
// group's OWN rules is remembered in every member clone instead, under a key
// of its own (workler.groupCopyLinks). It is deliberately not derived from
// the members' workler.copyLinks: `apply <name>/<project> --no-copy-links`
// switches one member's mode and must not silently flip the group's, whose
// link destinations are still the stored copies.
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
