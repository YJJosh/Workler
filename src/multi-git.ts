import fs from 'node:fs';
import path from 'node:path';
import { MAIN_WORKSPACE_NAME, WORKSPACES_DIR } from './constants';
import { git, gitMaybe } from './git';
import { groupProjects, isGroupWorkspaceDirectory, memberBrokenReason, memberPath, sourceBrokenReason } from './groups';
import { listWorkspaces } from './workspaces';
import type { Workspace } from './types';

export interface SyncTarget extends Workspace {
  /** Why the directory is not a usable git repository, for display. */
  broken?: string;
  /** Under a group root: the declared project; `name` is the workspace or "main". */
  project?: string;
}

export function targetLabel(target: SyncTarget): string {
  return target.project === undefined ? target.name : `${target.name}/${target.project}`;
}

// Unlike listWorkspaces(), flags directories that are not clones, so a broken
// workspace does not vanish from `status`.
export function listSyncTargets(root: string): SyncTarget[] {
  const projects = groupProjects(root);
  const targets = projects.length > 0 ? listGroupSyncTargets(root, projects) : listRepositorySyncTargets(root);

  // A directory can have .git and still be unreadable (e.g. corrupted).
  for (const target of targets) {
    if (!target.broken && gitMaybe(target.path, ['rev-parse', '--git-dir']) === undefined) {
      target.broken = 'git cannot read this repository';
    }
  }
  return targets;
}

function listRepositorySyncTargets(root: string): SyncTarget[] {
  const targets: SyncTarget[] = listWorkspaces(root).map((workspace) => ({ ...workspace }));
  const known = new Set(targets.map((target) => target.path));

  const workspacesPath = path.join(root, WORKSPACES_DIR);
  if (fs.existsSync(workspacesPath)) {
    for (const entry of fs.readdirSync(workspacesPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const workspacePath = path.join(workspacesPath, entry.name);
      if (!known.has(workspacePath)) {
        try {
          // A linked `git worktree` has a .git file; it is not a Workler clone.
          if (!fs.lstatSync(path.join(workspacePath, '.git')).isDirectory()) {
            continue;
          }
        } catch (_) {
          targets.push({ name: entry.name, path: workspacePath, broken: 'missing .git (not a clone)' });
        }
      }
    }
  }

  const [main, ...rest] = targets;
  rest.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return main ? [main, ...rest] : rest;
}

// The sources as "main", then every member of every group workspace. Missing
// members and stray directories are flagged, not hidden.
function listGroupSyncTargets(root: string, projects: string[]): SyncTarget[] {
  const targets: SyncTarget[] = [];
  for (const project of projects) {
    const source = memberPath(root, project);
    targets.push({
      name: MAIN_WORKSPACE_NAME,
      path: source,
      project,
      broken: sourceBrokenReason(root, project),
    });
  }

  const workspacesPath = path.join(root, WORKSPACES_DIR);
  if (!fs.existsSync(workspacesPath)) {
    return targets;
  }
  const entries = fs.readdirSync(workspacesPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const workspacePath = path.join(workspacesPath, entry.name);
    if (!isGroupWorkspaceDirectory(workspacePath, projects)) {
      targets.push({ name: entry.name, path: workspacePath, broken: 'not a group workspace (no declared project is cloned here)' });
      continue;
    }
    for (const project of projects) {
      const member = memberPath(workspacePath, project);
      targets.push({
        name: entry.name,
        path: member,
        project,
        broken: memberBrokenReason(workspacePath, project),
      });
    }
  }
  return targets;
}

export interface BranchInfo {
  detached: boolean;
  /** Branch name, or the short commit SHA when detached. */
  branch: string;
}

export function branchInfo(repo: string): BranchInfo {
  const ref = gitMaybe(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (ref && ref !== 'HEAD') {
    return { detached: false, branch: ref };
  }
  return { detached: true, branch: gitMaybe(repo, ['rev-parse', '--short', 'HEAD']) || '?' };
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

/** Undefined when there is no upstream, or HEAD is detached or unborn. */
export function aheadBehindUpstream(repo: string): AheadBehind | undefined {
  const counts = gitMaybe(repo, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
  if (counts === undefined) {
    return undefined;
  }
  const [ahead, behind] = counts.split(/\s+/).map(Number);
  return { ahead, behind };
}

export function describeAheadBehind(counts: AheadBehind): string {
  if (counts.ahead === 0 && counts.behind === 0) {
    return 'up to date';
  }
  const parts: string[] = [];
  if (counts.ahead > 0) {
    parts.push(`ahead ${counts.ahead}`);
  }
  if (counts.behind > 0) {
    parts.push(`behind ${counts.behind}`);
  }
  return parts.join(', ');
}

/** Tracked files only: copy rules create untracked files and a fast-forward never overwrites those. Undefined when Git fails. */
export function trackedChanges(repo: string): boolean | undefined {
  const status = gitMaybe(repo, ['status', '--porcelain', '--untracked-files=no']);
  return status === undefined ? undefined : status !== '';
}

export interface FetchResult {
  line: string;
  /** True only when a fetch was attempted and failed; no origin is not a failure. */
  failed: boolean;
}

/** Never throws, so one bad remote does not stop the loop over the others. */
export function fetchOrigin(repo: string): FetchResult {
  const remotes = gitMaybe(repo, ['remote']);
  if (remotes === undefined) {
    return { line: 'failed: git could not list remotes', failed: true };
  }
  if (!remotes.split('\n').includes('origin')) {
    return { line: 'skipped (no origin remote)', failed: false };
  }
  try {
    // Let fetch report an origin with a missing or bad URL; `remote get-url`
    // would make that look like no origin.
    git(repo, ['fetch', '--prune', 'origin']);
    return { line: 'fetched origin', failed: false };
  } catch (error) {
    return { line: `failed: ${(error as Error).message}`, failed: true };
  }
}

export function nameWidth(targets: SyncTarget[]): number {
  return Math.max(4, ...targets.map((target) => targetLabel(target).length));
}
