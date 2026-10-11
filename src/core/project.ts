import fs from 'node:fs';
import path from 'node:path';
import { canWriteConfigPath, quoteConfigPath, readConfig } from '../config';
import { CONFIG_FILE, MAIN_WORKSPACE_NAME, WORKSPACES_DIR } from '../constants';
import { WorklerError } from '../errors';
import { addLineIfMissing, canonicalPath, pathsReferToSameLocation } from '../fs-utils';
import { ensureGitRepo, git, gitInfoExcludePath, gitMaybe, hasIndependentGitDirectory, isGitTopLevel } from '../git';
import { memberPath, sourceBrokenReason } from '../groups';
import { withProjectLocks } from '../lock';
import { groupMembership, groupWorkspaceParent, parentProject } from '../workspaces';
import type { GroupMembership } from '../workspaces';

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
  // parent project it was cloned from (nested workspaces), or the group root
  // for a group workspace directory.
  parent?: string;
  // The `project <path>` entries of a project group, in file order. Always
  // empty for a Git repository.
  projects: string[];
  // A project group: a non-Git root whose .workler declares projects. `add`
  // clones every project into one workspace directory.
  isGroup: boolean;
  // Set when .workler exists but cannot be parsed. inspectProject never
  // throws; the operations surface this as CONFIG_INVALID.
  configError?: string;
  // Set when this project is a member clone of a group workspace.
  memberOf?: GroupMembership;
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
      projects: [],
      isGroup: false,
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

  let projects: string[] = [];
  let configError: string | undefined;
  if (!gitRepo && configFileExists) {
    try {
      projects = readConfig(root).projects.map((entry) => entry.path);
    } catch (error) {
      if (!(error instanceof WorklerError) || error.code !== 'CONFIG_INVALID') {
        throw error;
      }
      configError = error.message;
    }
  }

  let parent: string | undefined;
  let memberOf: GroupMembership | undefined;
  if (gitRepo) {
    parent = parentProject(root);
    if (parent) {
      memberOf = groupMembership(root);
    }
  } else {
    try {
      parent = groupWorkspaceParent(root)?.group;
    } catch (_) {
      // The enclosing group's config is broken: not this directory's problem.
    }
  }

  return {
    root,
    exists,
    gitRepo,
    marked,
    configFileExists,
    workspacesDirExists,
    initialized: gitRepo || configFileExists,
    parent,
    projects,
    isGroup: projects.length > 0,
    configError,
    memberOf,
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

// Guard for the multi-repository commands (status/fetch/sync/branch-sync):
// a Git repository, or a project group whose members are repositories.
export function requireRepositoryOrGroup(rootInput: string, command: string): ProjectInfo {
  const info = inspectProject(rootInput);
  if (info.isGroup) {
    return info;
  }
  if (info.configError) {
    throw new WorklerError('CONFIG_INVALID', info.configError, { root: info.root });
  }
  ensureGitRepo(info.root, command);
  return info;
}

// Git repositories directly below `root` or one level deeper (`projects/api`),
// as portable relative paths in sorted order. Hidden directories (including
// .worktrees) and node_modules are skipped, as are linked `git worktree`
// checkouts (a .git file), which are not independent clones.
export function discoverProjects(rootInput: string): string[] {
  const root = path.resolve(rootInput);
  const found: string[] = [];
  const visit = (dir: string, relative: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      const child = path.join(dir, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (hasIndependentGitDirectory(child)) {
        found.push(childRelative);
        continue;
      }
      if (depth < 2) {
        visit(child, childRelative, depth + 1);
      }
    }
  };
  visit(root, '', 1);
  return found;
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
  // The `project <path>` entries the config declares after init (the ones
  // written for a new group config, or the ones an existing file already had).
  projects: string[];
  // Git repositories found below a non-Git root (see discoverProjects), whether
  // or not the config declares them. Empty for a Git repository.
  discoveredProjects: string[];
  // Discovered repositories left out of a new config because their path
  // cannot be spelled in .workler (both quote characters, or a line break).
  // Reported so the folder can be renamed.
  unwritableProjects: string[];
}

// The locks a mutating operation rooted at `info.root` must hold, outermost
// first. A clone inside a project group workspace holds the group's lock as
// well as its own: `remove <name>` and `apply <name>` at the group root hold
// only the group's lock while they delete or rewrite the member clones, so a
// command that creates or removes inside the clone has to share that lock, or
// `remove feat` could pass its cleanliness check and then delete a nested
// workspace that `add` is still cloning inside feat/projects/api. A workspace
// nested deeper, inside the clone's own .worktrees/, is a nested project and
// locks only itself, like every nested project.
// The group a root sits directly inside, if any: a member clone belongs to
// the group that cloned it, and a group workspace folder (a nested group)
// belongs to the group that created it. `remove <name>` at that group deletes
// either one under the group's lock alone.
function enclosingGroupOf(info: Pick<ProjectInfo, 'gitRepo' | 'parent' | 'memberOf'>): string | undefined {
  if (info.memberOf) {
    return info.memberOf.group;
  }
  return info.gitRepo ? undefined : info.parent;
}

// The locks a mutating operation at `info.root` must hold, outermost first:
// every enclosing group up the chain, then the root's own. A workspace nested
// inside a Git clone's own .worktrees/ is not part of the chain; it locks
// itself, as nested workspaces always have.
export function lockRootsOf(info: Pick<ProjectInfo, 'root' | 'gitRepo' | 'parent' | 'memberOf'>): string[] {
  const roots = [info.root];
  let outer = enclosingGroupOf(info);
  while (outer !== undefined) {
    const next = outer;
    if (roots.some((root) => pathsReferToSameLocation(root, next))) {
      break;
    }
    roots.unshift(next);
    outer = enclosingGroupOf(inspectProject(next));
  }
  return roots;
}

// fetch, sync and branch-sync at a group root also fetch into, fast-forward
// and write refs into the declared source repositories, so they hold each
// usable source's locks too, in declared order; a `sync` run inside a source
// then cannot interleave with the group's. Unusable sources (missing, not a
// repository, behind a link) are skipped by those commands and not locked:
// locking one would create .worktrees/ at a path Workler must not touch.
export function syncLockRootsOf(info: ProjectInfo): string[] {
  const roots = lockRootsOf(info);
  if (!info.isGroup) {
    return roots;
  }
  for (const project of info.projects) {
    if (sourceBrokenReason(info.root, project) !== undefined) {
      continue;
    }
    for (const root of lockRootsOf(inspectProject(memberPath(info.root, project)))) {
      if (!roots.some((have) => pathsReferToSameLocation(have, root))) {
        roots.push(root);
      }
    }
  }
  return roots;
}

export function initProject(rootInput: string): InitResult {
  const root = path.resolve(rootInput);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new WorklerError('ROOT_NOT_FOUND', `project root does not exist: ${root}`, { root });
  }

  return withProjectLocks(lockRootsOf(inspectProject(root)), 'init', () => {
    const configPath = path.join(root, CONFIG_FILE);
    const workspacesPath = path.join(root, WORKSPACES_DIR);
    const gitRepo = isGitProjectRoot(root);
    // A plain folder holding several repositories is a project group in the
    // making: declare what is there so `add` can clone all of it.
    const found = gitRepo ? [] : discoverProjects(root);
    const discoveredProjects = found.filter(canWriteConfigPath);
    const unwritableProjects = found.filter((project) => !canWriteConfigPath(project));

    let configCreated = false;
    let projects: string[] = [];
    if (!fs.existsSync(configPath)) {
      if (discoveredProjects.length > 0) {
        fs.writeFileSync(configPath, groupConfigTemplate(discoveredProjects));
        projects = discoveredProjects;
      } else {
        fs.writeFileSync(configPath, PROJECT_CONFIG_TEMPLATE);
      }
      configCreated = true;
    } else if (!gitRepo) {
      try {
        projects = readConfig(root).projects.map((entry) => entry.path);
      } catch (_) {
        // init leaves an existing file alone, broken or not; the operations
        // that need it report the parse error.
      }
    }

    fs.mkdirSync(workspacesPath, { recursive: true });

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

    return {
      root,
      configPath,
      configCreated,
      workspacesPath,
      gitRepo,
      excludePath,
      gitignorePath,
      projects,
      discoveredProjects,
      unwritableProjects,
    };
  });
}

const PROJECT_CONFIG_TEMPLATE = [
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
].join('\n');

function groupConfigTemplate(projects: string[]): string {
  return [
    '# Workler project group',
    '#',
    '# This folder is not a Git repository; the repositories below it are',
    '# listed here. `workler add <name>` clones every one of them into',
    `# ${WORKSPACES_DIR}/<name>/ in the same layout. Each repository keeps its own`,
    `# ${CONFIG_FILE} for its copy/link rules.`,
    '#',
    '# Syntax:',
    '#   project <path>  # a Git repository below this folder',
    '#   link <path>     # symlink from the workspace folder back to this folder',
    '#   copy <path>     # copy into the workspace folder when applied',
    '',
    ...projects.map((project) => `project ${quoteConfigPath(project)}`),
    '',
  ].join('\n');
}
