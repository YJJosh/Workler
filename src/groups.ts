import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config';
import { CONFIG_FILE, GROUP_WORKSPACE_REFS, WORKSPACES_DIR } from './constants';
import { WorklerError } from './errors';
import { canonicalPath } from './fs-utils';
import { hasIndependentGitDirectory, isGitTopLevel } from './git';

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
  return projects.some((project) => hasIndependentGitDirectory(memberPath(dir, project)));
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

function configCopyMatches(dir: string, groupRoot: string): boolean {
  try {
    return fs.readFileSync(path.join(dir, CONFIG_FILE)).equals(fs.readFileSync(path.join(groupRoot, CONFIG_FILE)));
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
