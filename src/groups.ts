import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config';
import { CONFIG_FILE, GROUP_WORKSPACE_REFS, ROOT_REMOTE, WORKSPACES_DIR } from './constants';
import { WorklerError } from './errors';
import { canonicalPath, pathsReferToSameLocation } from './fs-utils';
import { gitMaybe, hasIndependentGitDirectory, isGitTopLevel } from './git';

// A project group is a plain folder (not a Git repository) whose .workler
// lists the repositories below it with `project <path>` lines. `add` run
// there clones every listed repository into .worktrees/<name>/<path>, in the
// same layout as the group root, so relative paths between the projects keep
// working. Each clone is an ordinary Workler workspace of its source
// repository (rules, link targets and branch-sync come from there); the
// group only decides where the clones live and manages them as one unit.

// The declared project paths of a group root, in file order. A Git repository
// is never a group, whatever its .workler says; `add` rejects that mix with a
// clear message instead of silently ignoring the lines.
export function groupProjects(root: string): string[] {
  if (!fs.existsSync(path.join(root, CONFIG_FILE)) || isGitTopLevel(root)) {
    return [];
  }
  return readConfig(root).projects.map((entry) => entry.path);
}

export function hasGroupConfig(dir: string): boolean {
  return groupProjects(dir).length > 0;
}

// Absolute location of a declared project below a group root or below one
// of its workspaces. Project paths are stored with forward slashes.
export function memberPath(base: string, project: string): string {
  return path.join(base, ...project.split('/'));
}

// A group workspace is a plain directory under .worktrees/ (never itself a
// clone). It is recognized by the .workler copy `add` places there or, when
// that copy is missing, by any declared project that has been cloned into it.
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
  // A declared project path inside the workspace (`feat/projects/api`).
  project?: string;
}

// Workspace names never contain a path separator (validateWorkspaceName), so
// the first slash unambiguously splits `<workspace>/<project path>`.
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

// What lstat finds on the way from `base` to the declared `project`, never
// following a link: the first entry that is not a real directory decides.
// `ancestor` names that entry (relative to the base) when it was not the
// member itself.
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

// What sits at a declared member path below a workspace folder. Only a real
// directory with its own .git directory, reached through real directories, is
// a clone. A symbolic link (whatever it points at, even the source
// repository) or a file, at the member's path or at any folder on the way to
// it (`projects` for `projects/api`), is never something Workler put there:
// it is local data, and following the link would inspect the wrong
// directory. So every component is checked with lstat and none is followed.
export type MemberState = 'missing' | 'clone' | 'link' | 'not-a-clone' | 'foreign';

export interface MemberCheck {
  state: MemberState;
  // For 'link' and 'not-a-clone': the folder on the way to the member that
  // decided the state (relative to the base), when it was not the member.
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

// Whether the repository at a member path is the clone Workler made there,
// judged by the identity `add` records in its git config and not by the mere
// presence of a .git directory. An unrelated repository dropped at the path
// must count as local data: not something remove may delete without --force,
// nor something apply, sync and branch-sync may write into.
//
// `add` records a member over several git commands (clone; workler.root and
// workler.name; the remotes; workler.group; workler.groupProject), so an
// interrupted run can leave any prefix of that sequence behind. Every mark
// that is present must match this slot, and the clone must be anchored to
// the source: by workler.root or, before that is written, by the origin
// remote `git clone --local <source>` leaves (or the workler-root remote that
// replaces it). A clone recorded for another source, workspace or group is
// not this member, however well it fits the slot.
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

// The repository's local git config as key -> values. Git lowercases the
// section and variable names in --list output, so look keys up lowercased.
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

// Why a repository at a member path is not treated as the member's clone.
export function foreignMemberReason(project: string): string {
  return `not the recorded clone of ${project}: unrelated, or made for another location`;
}

export function memberState(base: string, project: string): MemberState {
  return inspectMember(base, project).state;
}

// The reason when a folder on the way to the member decided its state, or
// undefined when the member itself did (callers word that case themselves).
export function ancestorReason(check: MemberCheck): string | undefined {
  if (check.ancestor === undefined) {
    return undefined;
  }
  return check.state === 'link'
    ? `behind a symbolic link at ${check.ancestor}, not a clone`
    : `behind a file at ${check.ancestor}, not a clone`;
}

// Why a declared member is not a usable clone, or undefined when it is one.
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

// Why a declared source repository (a `project` path below the group root)
// cannot be used, or undefined when it can. Same walk as for members: a
// symbolic link anywhere on the way is refused, never followed, so a group
// only ever reaches repositories that physically live below its root. Used
// before `add` clones from a source and by the target lister behind status,
// sync, branch-sync and apply.
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

// Entries in a group workspace directory that belong to no declared project:
// not an unchanged .workler copy, not a project or a directory on the way
// to one.
// Files a group-level `copy` rule produced count too, exactly like a copied
// .env inside a clone counts as local data for `remove`. An empty nested
// .worktrees/ (left behind by a lock) holds nothing and is ignored.
export function groupWorkspaceExtras(dir: string, groupRoot: string, projects: string[]): string[] {
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
        // The generated copy of the group's .workler is ours to delete. Once
        // it differs (edited for nested group workspaces, or the group's file
        // changed after creation) it is local data like any other edit.
        if (configCopyMatches(dir, groupRoot)) {
          continue;
        }
        extras.push(entryPath);
        continue;
      }
      if (projects.includes(entryPath)) {
        // A member is a directory: a clone, or one still to be made. A
        // symbolic link or a file at a declared path is local data.
        if (entry.isDirectory()) {
          continue;
        }
        extras.push(entryPath);
        continue;
      }
      if (entry.isDirectory() && projects.some((project) => project.startsWith(`${entryPath}/`))) {
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

// The copy counts as generated only while it is a regular file holding the
// group's exact bytes. A symbolic link in its place is the user's, even when
// it points at the group's file: nothing follows links, so it is local data.
function configCopyMatches(dir: string, groupRoot: string): boolean {
  try {
    const copy = path.join(dir, CONFIG_FILE);
    if (!fs.lstatSync(copy).isFile()) {
      return false;
    }
    return fs.readFileSync(copy).equals(fs.readFileSync(path.join(groupRoot, CONFIG_FILE)));
  } catch (_) {
    return false;
  }
}

// Where `branch-sync` run at a group root mirrors a member clone's branches
// inside its source repository: <GROUP_WORKSPACE_REFS>/<group>/<workspace>/
// <branch>. A repository can belong to several groups (a group folder inside
// another group folder), and pruning deletes everything under the namespace
// that no current workspace of the group owns, so the namespace carries the
// group itself: its folder name made safe for a ref name, plus a hash of its
// canonical path so two groups with the same folder name stay apart.
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
