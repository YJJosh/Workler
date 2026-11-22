import fs from 'node:fs';
import path from 'node:path';
import { canWriteConfigPath, pathsOverlap, quoteConfigPath, readConfig } from '../config';
import { CONFIG_FILE } from '../constants';
import { WorklerError } from '../errors';
import { hasIndependentGitDirectory } from '../git';
import { memberPath, sourceBrokenReason } from '../groups';
import { withProjectLocks } from '../lock';
import { inspectProject, lockRootsOf } from './project';

export interface GroupProjectsResult {
  /** The group's `project <path>` entries after the change, in file order. */
  projects: string[];
}

function requireGroup(rootInput: string) {
  const info = inspectProject(rootInput);
  if (info.configError !== undefined) {
    throw new WorklerError('CONFIG_INVALID', info.configError, { root: info.root });
  }
  if (!info.isGroup) {
    throw new WorklerError('NOT_INITIALIZED', `not a project group: ${info.root}`, { root: info.root });
  }
  return info;
}

// Keeps every other line, comment and line ending as written.
function writeConfigLines(root: string, update: (lines: string[], newline: string) => string[]): string[] {
  const configPath = path.join(root, CONFIG_FILE);
  const before = fs.readFileSync(configPath, 'utf8');
  const newline = before.includes('\r\n') ? '\r\n' : '\n';
  const trailing = before.endsWith('\n');
  const lines = (trailing ? before.slice(0, before.endsWith('\r\n') ? -2 : -1) : before).split(/\r?\n/);
  const after = update(lines, newline).join(newline) + (trailing ? newline : '');
  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, after);
  fs.renameSync(temporary, configPath);
  try {
    return readConfig(root).projects.map((entry) => entry.path);
  } catch (error) {
    fs.writeFileSync(configPath, before);
    throw error;
  }
}

function isProjectLine(line: string): boolean {
  return /^\s*project(\s|$)/.test(line);
}

/**
 * Declares the repository at `<root>/<project>` as a member of the group at `root`.
 * Workspaces created before keep their own member list; only new ones clone it.
 */
export function addGroupProject(rootInput: string, project: string): GroupProjectsResult {
  const info = requireGroup(rootInput);
  return withProjectLocks(lockRootsOf(info), `add project ${project}`, () => {
    const config = readConfig(info.root);
    if (!canWriteConfigPath(project) || path.isAbsolute(project) || project.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new WorklerError('INVALID_OPTIONS', `cannot declare "${project}": use a relative path without . or .. parts, line breaks or backslashes`, { project });
    }
    const declared = [...config.projects.map((entry) => entry.path), ...config.rules.map((rule) => rule.targetPath)];
    const overlaps = declared.find((other) => pathsOverlap(project, other));
    if (overlaps !== undefined) {
      throw new WorklerError('INVALID_OPTIONS', `"${project}" overlaps "${overlaps}" in ${CONFIG_FILE}`, { project, overlaps });
    }
    // The checks `add` makes before cloning, so a declared member never blocks new workspaces.
    const unusable =
      sourceBrokenReason(info.root, project) ??
      (hasIndependentGitDirectory(memberPath(info.root, project)) ? undefined : 'a linked worktree, not a repository of its own');
    if (unusable !== undefined) {
      throw new WorklerError('NOT_A_GIT_REPO', `cannot declare "${project}": ${unusable}`, { project, reason: unusable });
    }
    const projects = writeConfigLines(info.root, (lines) => {
      const last = lines.reduce((found, line, index) => (isProjectLine(line) ? index : found), -1);
      const at = last === -1 ? lines.length : last + 1;
      return [...lines.slice(0, at), `project ${quoteConfigPath(project)}`, ...lines.slice(at)];
    });
    return { projects };
  });
}

/**
 * Stops declaring `project` in the group at `root`. Its folder stays where it is, and
 * workspaces that hold a clone of it keep it until they are removed.
 */
export function removeGroupProject(rootInput: string, project: string): GroupProjectsResult {
  const info = requireGroup(rootInput);
  return withProjectLocks(lockRootsOf(info), `remove project ${project}`, () => {
    const entries = readConfig(info.root).projects;
    const entry = entries.find((candidate) => candidate.path === project);
    if (entry === undefined) {
      throw new WorklerError('INVALID_OPTIONS', `"${project}" is not a project of this group`, { project });
    }
    if (entries.length === 1) {
      throw new WorklerError('INVALID_OPTIONS', `"${project}" is the group's only project`, { project });
    }
    const projects = writeConfigLines(info.root, (lines) => {
      const index = lines.findIndex((line) => line.trim() === entry.raw);
      return index === -1 ? lines : [...lines.slice(0, index), ...lines.slice(index + 1)];
    });
    return { projects };
  });
}
