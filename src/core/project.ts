import fs from 'node:fs';
import path from 'node:path';
import { canWriteConfigPath, pathsOverlap, quoteConfigPath, readConfig } from '../config';
import { CONFIG_FILE, MAIN_WORKSPACE_NAME, WORKSPACES_DIR } from '../constants';
import { WorklerError } from '../errors';
import { addLineIfMissing, canonicalPath, pathsReferToSameLocation } from '../fs-utils';
import { ensureGitRepo, git, gitInfoExcludePath, gitMaybe, hasIndependentGitDirectory, isGitTopLevel } from '../git';
import { memberPath, sourceBrokenReason } from '../groups';
import { withProjectLocks } from '../lock';
import { groupWorkspaceParent, resolveParent } from '../workspaces';
import type { GroupMembership } from '../workspaces';

// The toplevel itself, not merely inside a repository: `git clone --local
// <subdir>` would clone an enclosing repository the caller did not name.
export function isGitProjectRoot(dir: string): boolean {
  return isGitTopLevel(dir);
}

export interface ProjectInfo {
  /** Absolute, resolved project root. */
  root: string;
  exists: boolean;
  /** `root` is the toplevel of a git repository. */
  gitRepo: boolean;
  /** git config workler.name or workler.root is set. */
  marked: boolean;
  configFileExists: boolean;
  workspacesDirExists: boolean;
  /** Any Git repository, or a non-Git directory with a .workler file. */
  initialized: boolean;
  /**
   * When this is a managed workspace: the project it was cloned from, or the
   * group root for a group workspace folder. For a member clone: the source,
   * only while it is usable and reached without symlinks.
   */
  parent?: string;
  /** A group's `project <path>` entries in file order; empty for a Git repository. */
  projects: string[];
  /** A non-Git root whose .workler declares projects. */
  isGroup: boolean;
  /** .workler does not parse. inspectProject never throws; operations raise CONFIG_INVALID. */
  configError?: string;
  /**
   * Set for a member clone of a group workspace, even when an interrupted
   * `add` never marked it or the source is gone: the group still owns it.
   */
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
    ({ parent, memberOf } = resolveParent(root));
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

/**
 * Git repositories up to two levels below `root`, as sorted forward-slash
 * paths. Skips hidden directories, node_modules and linked `git worktree`s.
 */
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
  /** False when a .workler file already existed and was left untouched. */
  configCreated: boolean;
  workspacesPath: string;
  gitRepo: boolean;
  /** Where the ".worktrees/" ignore line went: .git/info/exclude for a git project. */
  excludePath?: string;
  /** Where the ".worktrees/" ignore line went for a non-Git folder. */
  gitignorePath?: string;
  /** The `project <path>` entries the config declares after init. */
  projects: string[];
  /** Repositories found below a non-Git root, declared or not. */
  discoveredProjects: string[];
  /** Left out of a new config: the path cannot be spelled in .workler. */
  unwritableProjects: string[];
  /**
   * Left out because the path overlaps a declared or earlier one, compared
   * like the parser does (case-insensitively, parent against child).
   */
  overlappingProjects: Array<{ path: string; overlaps: string }>;
  /** Why an existing .workler does not parse; the file is left as is. */
  configError?: string;
}

// A member clone belongs to the group that cloned it, and a group workspace
// folder to the group that created it.
function enclosingGroupOf(info: Pick<ProjectInfo, 'gitRepo' | 'parent' | 'memberOf'>): string | undefined {
  if (info.memberOf) {
    return info.memberOf.group;
  }
  return info.gitRepo ? undefined : info.parent;
}

/**
 * Every enclosing group, outermost first, then the root. `remove` and `apply`
 * at a group hold only the group's lock while changing member clones, so work
 * inside a clone must share it. A workspace nested in a clone locks only itself.
 */
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

/**
 * Adds each usable source's locks for group commands that read or write the
 * sources. Broken sources are not locked: that would create .worktrees/ at a
 * path Workler must not touch.
 */
export function lockRootsWithSourcesOf(info: ProjectInfo): string[] {
  const roots = lockRootsOf(info);
  if (!info.isGroup) {
    return roots;
  }
  for (const project of info.projects) {
    if (sourceBrokenReason(info.root, project) !== undefined) {
      continue;
    }
    mergeLockRoots(roots, lockRootsOf(inspectProject(memberPath(info.root, project))));
  }
  return roots;
}

/** Appends to `roots` in place; a lock can be taken only once per process. */
export function mergeLockRoots(roots: string[], more: readonly string[]): string[] {
  for (const root of more) {
    if (!roots.some((have) => pathsReferToSameLocation(have, root))) {
      roots.push(root);
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
    const found = gitRepo ? [] : discoverProjects(root);
    const unwritableProjects = found.filter((project) => !canWriteConfigPath(project));

    let configCreated = false;
    let projects: string[] = [];
    let declaredPaths: string[] = [];
    let configError: string | undefined;
    const configExists = fs.existsSync(configPath);
    if (configExists && !gitRepo) {
      try {
        const config = readConfig(root);
        projects = config.projects.map((entry) => entry.path);
        declaredPaths = [...config.rules.map((rule) => rule.targetPath), ...projects];
      } catch (error) {
        // init leaves an existing file alone, broken or not; it only reports it.
        configError = error instanceof Error ? error.message : String(error);
      }
    }

    // An overlapping path would make the written file fail to parse.
    const discoveredProjects: string[] = [];
    const overlappingProjects: Array<{ path: string; overlaps: string }> = [];
    for (const candidate of found.filter(canWriteConfigPath)) {
      const overlaps = projects.includes(candidate)
        ? undefined
        : [...declaredPaths, ...discoveredProjects].find((other) => pathsOverlap(candidate, other));
      if (overlaps === undefined) {
        discoveredProjects.push(candidate);
      } else {
        overlappingProjects.push({ path: candidate, overlaps });
      }
    }

    if (!configExists) {
      if (discoveredProjects.length > 0) {
        fs.writeFileSync(configPath, groupConfigTemplate(discoveredProjects));
        projects = discoveredProjects;
      } else {
        fs.writeFileSync(configPath, PROJECT_CONFIG_TEMPLATE);
      }
      configCreated = true;
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
      overlappingProjects,
      configError,
    };
  });
}

const PROJECT_CONFIG_TEMPLATE = [
  '# Workler local workspace rules',
  '#',
  '# Syntax:',
  '#   link <path>                          # symlink from workspace back to this project',
  '#   copy <path>                          # copy into each workspace when applied',
  '#   setup <command>                      # run in a new workspace after the rules (re-run: workler setup)',
  '#   setup --if-missing <path> <command>  # same, but only while <path> is absent from the workspace',
  '#',
  '# Examples:',
  '# link node_modules',
  '# copy .env',
  '# setup --if-missing node_modules pnpm install',
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
    '#   project <path>   # a Git repository below this folder',
    '#   link <path>      # symlink from the workspace folder back to this folder',
    '#   copy <path>      # copy into the workspace folder when applied',
    '#   setup <command>  # run in the workspace folder once every project is cloned and set up',
    '',
    ...projects.map((project) => `project ${quoteConfigPath(project)}`),
    '',
  ].join('\n');
}
