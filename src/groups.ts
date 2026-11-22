import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config';
import { CONFIG_FILE, GROUP_WORKSPACE_REFS, ROOT_REMOTE, SETUP_RECORD_FILE, WORKSPACES_DIR } from './constants';
import { WorklerError } from './errors';
import { canonicalPath, pathsReferToSameLocation } from './fs-utils';
import { gitMaybe, hasIndependentGitDirectory, isGitTopLevel } from './git';
import { readSetupRecordFile } from './setup';

// A group workspace clones every declared repository into .worktrees/<name>/<path>, keeping the layout
// so relative paths between projects still work. Each clone takes its rules from its own source.

// A Git repository is never a group, whatever its .workler says.
export function groupProjects(root: string): string[] {
  if (!fs.existsSync(path.join(root, CONFIG_FILE)) || isGitTopLevel(root)) {
    return [];
  }
  return readConfig(root).projects.map((entry) => entry.path);
}

export function hasGroupConfig(dir: string): boolean {
  return groupProjects(dir).length > 0;
}

export function memberPath(base: string, project: string): string {
  return path.join(base, ...project.split('/'));
}

// Recognized by the .workler copy `add` places there, or by any cloned member.
export function isGroupWorkspaceDirectory(dir: string, projects: string[]): boolean {
  if (hasIndependentGitDirectory(dir)) {
    return false;
  }
  if (fs.existsSync(path.join(dir, CONFIG_FILE))) {
    return true;
  }
  return projects.some((project) => memberState(dir, project) === 'clone');
}

export interface WorkspaceAddress {
  workspace: string;
  /** A declared project path inside the workspace (`projects/api` in `feat/projects/api`). */
  project?: string;
}

// Workspace names never contain a separator, so the first slash splits.
export function splitWorkspaceAddress(address: string): WorkspaceAddress {
  const normalized = address.replace(/\\/g, '/');
  const separator = normalized.indexOf('/');
  if (separator === -1) {
    return { workspace: normalized };
  }
  const project = normalized
    .slice(separator + 1)
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
  return { workspace: normalized.slice(0, separator), project: project || undefined };
}

export function requireDeclaredProject(projects: string[], project: string): string {
  const found = projects.find((candidate) => candidate === project);
  if (found === undefined) {
    const declared = projects.length > 0 ? projects.join(', ') : '(none)';
    throw new WorklerError(
      'WORKSPACE_NOT_FOUND',
      `project not found in this group: ${project}\ndeclared projects: ${declared}`,
      { project, projects },
    );
  }
  return found;
}

// lstat each component, never following a link; the first entry that is not
// a real directory decides. `ancestor` names it when it is not the member.
interface MemberWalk {
  kind: 'missing' | 'link' | 'file' | 'directory';
  ancestor?: string;
}

function walkToMember(base: string, project: string): MemberWalk {
  const segments = project.split('/');
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const current = path.join(base, ...segments.slice(0, depth));
    const decided = (kind: MemberWalk['kind']): MemberWalk =>
      depth < segments.length ? { kind, ancestor: segments.slice(0, depth).join('/') } : { kind };
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (_) {
      return { kind: 'missing' };
    }
    if (stat.isSymbolicLink()) {
      return decided('link');
    }
    if (!stat.isDirectory()) {
      return decided('file');
    }
  }
  return { kind: 'directory' };
}

/**
 * Only a real directory with its own .git directory, reached through real directories, is a clone.
 * A symlink or file on the way is local data and is never followed, even when it points at the source.
 */
export type MemberState = 'missing' | 'clone' | 'link' | 'not-a-clone' | 'foreign';

export interface MemberCheck {
  state: MemberState;
  /** For 'link' and 'not-a-clone': the folder on the way that decided, if not the member. */
  ancestor?: string;
}

export function inspectMember(base: string, project: string): MemberCheck {
  const walk = walkToMember(base, project);
  const decided = (state: MemberState): MemberCheck =>
    walk.ancestor === undefined ? { state } : { state, ancestor: walk.ancestor };
  switch (walk.kind) {
    case 'missing':
      return { state: 'missing' };
    case 'link':
      return decided('link');
    case 'file':
      return decided('not-a-clone');
    default: {
      const member = memberPath(base, project);
      if (!hasIndependentGitDirectory(member)) {
        return { state: 'not-a-clone' };
      }
      return { state: isRecordedMember(base, project, member) ? 'clone' : 'foreign' };
    }
  }
}

// Judged by the identity `add` records in git config, not by a .git directory: an unrelated repository there is
// local data remove, apply and sync must not touch. An interrupted `add` can leave any prefix of its marks, so
// every mark present must match, and workler.root or (before that is written) a remote URL ties clone to source.
function isRecordedMember(base: string, project: string, member: string): boolean {
  const group = path.dirname(path.dirname(base));
  const source = memberPath(group, project);
  const config = localGitConfig(member);
  const value = (key: string): string | undefined => config.get(key)?.[0];
  const matchesIfSet = (recorded: string | undefined, expected: string): boolean =>
    recorded === undefined || pathsReferToSameLocation(recorded, expected);

  const recordedRoot = value('workler.root');
  const recordedName = value('workler.name');
  const recordedProject = value('workler.groupproject');
  if (
    !matchesIfSet(recordedRoot, source) ||
    (recordedName !== undefined && recordedName !== path.basename(base)) ||
    !matchesIfSet(value('workler.group'), group) ||
    (recordedProject !== undefined && recordedProject !== project)
  ) {
    return false;
  }
  if (recordedRoot !== undefined) {
    return true;
  }
  const remoteUrls = [...(config.get('remote.origin.url') ?? []), ...(config.get(`remote.${ROOT_REMOTE}.url`) ?? [])];
  return remoteUrls.some((url) => pathsReferToSameLocation(url, source));
}

// Git lowercases section and variable names in --list output.
function localGitConfig(repo: string): Map<string, string[]> {
  const values = new Map<string, string[]>();
  const listed = gitMaybe(repo, ['config', '--local', '-z', '--list']);
  if (listed === undefined) {
    return values;
  }
  for (const record of listed.split('\0')) {
    if (record === '') {
      continue;
    }
    const newline = record.indexOf('\n');
    const key = (newline === -1 ? record : record.slice(0, newline)).toLowerCase();
    const value = newline === -1 ? '' : record.slice(newline + 1);
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  return values;
}

export function foreignMemberReason(project: string): string {
  return `not the recorded clone of ${project}: unrelated, or made for another location`;
}

export function memberState(base: string, project: string): MemberState {
  return inspectMember(base, project).state;
}

/** Undefined when the member itself decided the state; callers word that case. */
export function ancestorReason(check: MemberCheck): string | undefined {
  if (check.ancestor === undefined) {
    return undefined;
  }
  return check.state === 'link'
    ? `behind a symbolic link at ${check.ancestor}, not a clone`
    : `behind a file at ${check.ancestor}, not a clone`;
}

export function memberBrokenReason(base: string, project: string): string | undefined {
  const check = inspectMember(base, project);
  switch (check.state) {
    case 'clone':
      return undefined;
    case 'missing':
      return 'missing (not cloned)';
    case 'link':
      return ancestorReason(check) ?? 'a symbolic link, not a clone';
    case 'foreign':
      return foreignMemberReason(project);
    default:
      return ancestorReason(check) ?? 'missing .git (not a clone)';
  }
}

/** Undefined when usable. A symlink on the way is refused, not followed, so a group only reaches repositories physically below it. */
export function sourceBrokenReason(groupRoot: string, project: string): string | undefined {
  const walk = walkToMember(groupRoot, project);
  switch (walk.kind) {
    case 'missing':
      return 'missing';
    case 'link':
      return walk.ancestor === undefined
        ? 'a symbolic link, not a repository'
        : `behind a symbolic link at ${walk.ancestor}, not a repository`;
    case 'file':
      return walk.ancestor === undefined
        ? 'not a Git repository top level'
        : `behind a file at ${walk.ancestor}, not a repository`;
    default:
      return isGitTopLevel(memberPath(groupRoot, project)) ? undefined : 'not a Git repository top level';
  }
}

/**
 * Entries in a group workspace that removal would lose: all but an unchanged .workler copy, members and folders
 * leading to them, `managedPaths` (group rule outputs), the setup record and an empty .worktrees/ left by a lock.
 */
export function groupWorkspaceExtras(dir: string, groupRoot: string, projects: string[], managedPaths: readonly string[] = []): string[] {
  const extras: string[] = [];
  const visit = (relative: string): void => {
    const current = relative ? memberPath(dir, relative) : dir;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
      if (!relative && entry.name === CONFIG_FILE) {
        // Once the copy differs from the group's file it is local data.
        if (configCopyMatches(dir, groupRoot)) {
          continue;
        }
        extras.push(entryPath);
        continue;
      }
      if (!relative && entry.name === SETUP_RECORD_FILE && readSetupRecordFile(dir) !== undefined) {
        // Only a record that reads exactly as Workler writes it is ours to delete.
        continue;
      }
      if (projects.includes(entryPath)) {
        // A symlink or file at a member path is local data.
        if (entry.isDirectory()) {
          continue;
        }
        extras.push(entryPath);
        continue;
      }
      if (managedPaths.includes(entryPath)) {
        continue;
      }
      if (entry.isDirectory() && [...projects, ...managedPaths].some((below) => below.startsWith(`${entryPath}/`))) {
        visit(entryPath);
        continue;
      }
      if (!relative && entry.name === WORKSPACES_DIR && entry.isDirectory()) {
        if (fs.readdirSync(path.join(dir, WORKSPACES_DIR)).length === 0) {
          continue;
        }
      }
      extras.push(entryPath);
    }
  };
  visit('');
  return extras;
}

// A symlink in its place is the user's, even when it points at the group's file. Project lines
// may differ: a workspace keeps the members it was created with while the group's list changes.
function configCopyMatches(dir: string, groupRoot: string): boolean {
  try {
    const copy = path.join(dir, CONFIG_FILE);
    if (!fs.lstatSync(copy).isFile()) {
      return false;
    }
    const group = path.join(groupRoot, CONFIG_FILE);
    if (fs.readFileSync(copy).equals(fs.readFileSync(group))) {
      return true;
    }
    // Only a copy that still parses may differ in its project lines: an invalid edit is local data.
    readConfig(dir);
    const withoutProjects = (file: string) =>
      fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => !/^\s*project(\s|$)/.test(line)).join('\n');
    return withoutProjects(copy) === withoutProjects(group);
  } catch (_) {
    return false;
  }
}

/**
 * The members a group workspace was made with, from its own .workler copy: the group's list may
 * have changed since. Falls back to the group's list when the copy is missing or unreadable.
 */
export function workspaceProjects(dir: string, groupProjects: string[]): string[] {
  try {
    if (fs.lstatSync(path.join(dir, CONFIG_FILE)).isFile()) {
      const own = readConfig(dir).projects.map((entry) => entry.path);
      if (own.length > 0) return own;
    }
  } catch (_) {
    // Removal reports a broken copy as local data.
  }
  return groupProjects;
}

/**
 * Where group-root `branch-sync` mirrors members in their sources: refs/workler-group/<group>/<workspace>/<branch>.
 * Pruning deletes what a group does not own and a repo can be in several, so <group> is the folder name plus a hash of its canonical path.
 */
export function groupRefNamespace(groupRoot: string): string {
  const canonical = canonicalPath(groupRoot);
  const hash = crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 12);
  const name =
    path
      .basename(canonical)
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'group';
  return `${GROUP_WORKSPACE_REFS}/${name}-${hash}`;
}

/** Prefixes a WorklerError message with the project path; code and details are kept. */
export function forProject<T>(project: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof WorklerError) {
      throw new WorklerError(error.code, `${project}: ${error.message}`, { ...error.details, project });
    }
    throw error;
  }
}

// Following a link to the source would make apply or setup rewrite the source.
export function notACloneReason(check: MemberCheck, project: string): string {
  const own = ancestorReason(check);
  if (own !== undefined) {
    return own;
  }
  switch (check.state) {
    case 'missing':
      return 'not cloned';
    case 'link':
      return 'a symbolic link, not a clone';
    case 'foreign':
      return foreignMemberReason(project);
    default:
      return 'not a clone';
  }
}
