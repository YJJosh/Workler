import fs from 'node:fs';
import path from 'node:path';
import { MAIN_WORKSPACE_NAME } from '../constants';
import { gitMaybe, isGitWorkTreeCleanIncludingIgnored } from '../git';
import { listSyncTargets } from '../multi-git';
import { findWorkspace } from '../workspaces';
import { requireProject } from './project';

export interface WorkspaceInfo {
  name: string;
  path: string;
  // The main project itself (always the first entry).
  isMain: boolean;
  // The directory has a .git entry (false for leftovers under .worktrees/
  // that are not clones at all).
  isClone: boolean;
  // Set when the directory is not a usable clone; human-readable reason.
  broken?: string;
  // Current branch; undefined when detached, unborn, or broken.
  branch?: string;
  // Full and abbreviated HEAD commit sha; undefined when unborn or broken.
  head?: string;
  shortHead?: string;
  detached: boolean;
  // No uncommitted changes, untracked files included — matches the guard
  // `remove` uses, so for non-main workspaces clean === removable without
  // force. Undefined when broken.
  clean?: boolean;
}

// Structured listing for the API: the main project, every workspace, and
// broken entries under .worktrees/ (flagged, not hidden).
export function listWorkspaceInfos(rootInput: string): WorkspaceInfo[] {
  const info = requireProject(rootInput);

  return listSyncTargets(info.root).map((target) => {
    const isMain = target.path === info.root;
    const isClone = isMain || fs.existsSync(path.join(target.path, '.git'));

    if (target.broken) {
      return { name: target.name, path: target.path, isMain, isClone, broken: target.broken, detached: false };
    }

    const abbrev = gitMaybe(target.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const detached = !abbrev || abbrev === 'HEAD';
    return {
      name: target.name,
      path: target.path,
      isMain,
      isClone,
      branch: detached ? undefined : abbrev,
      head: gitMaybe(target.path, ['rev-parse', 'HEAD']),
      shortHead: gitMaybe(target.path, ['rev-parse', '--short', 'HEAD']),
      detached,
      clean: isGitWorkTreeCleanIncludingIgnored(target.path),
    };
  });
}

// Absolute path of a workspace by name; "main" resolves to the root itself.
export function resolveWorkspacePath(rootInput: string, name: string): string {
  const info = requireProject(rootInput);
  if (name === MAIN_WORKSPACE_NAME) {
    return info.root;
  }
  return findWorkspace(info.root, name).path;
}
