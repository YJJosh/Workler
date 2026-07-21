import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACES_DIR } from './constants';
import { git, gitMaybe } from './git';
import { listWorkspaces } from './workspaces';
import type { Workspace } from './types';

// Shared plumbing for the multi-workspace commands (status/fetch/sync/
// branch-sync). Kept out of git.ts so single-repo helpers stay small.

export interface SyncTarget extends Workspace {
  // Set when the directory under .worktrees/ is not a usable git repository;
  // the value is a human-readable reason.
  broken?: string;
}

// listWorkspaces() silently ignores directories under .worktrees/ that are
// not git clones; the multi-workspace commands must FLAG those instead so a
// half-deleted or corrupted workspace does not vanish from `status`.
export function listSyncTargets(root: string): SyncTarget[] {
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
          // A linked `git worktree` has a .git file. It is a separate Git
          // checkout, not a broken Workler clone, so ignore it entirely.
          if (!fs.lstatSync(path.join(workspacePath, '.git')).isDirectory()) {
            continue;
          }
        } catch (_) {
          targets.push({ name: entry.name, path: workspacePath, broken: 'missing .git (not a clone)' });
        }
      }
    }
  }

  // A directory can have .git and still be unreadable (e.g. corrupted).
  for (const target of targets) {
    if (!target.broken && gitMaybe(target.path, ['rev-parse', '--git-dir']) === undefined) {
      target.broken = 'git cannot read this repository';
    }
  }

  const [main, ...rest] = targets;
  rest.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return main ? [main, ...rest] : rest;
}

export interface BranchInfo {
  detached: boolean;
  // Branch name, or the short commit SHA when detached.
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

// Compares HEAD to its upstream; undefined when the current branch has no
// upstream (or HEAD is detached/unborn).
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

// Copy rules (e.g. `copy .env`) create untracked files in every workspace by
// design, so plain `status --porcelain` would flag every workspace dirty
// forever. Only changes to tracked files count here; that stays safe because
// a fast-forward merge never overwrites untracked files (git refuses).
// Undefined means Git failed; callers can report that explicitly rather than
// silently presenting an unreadable repository as merely "dirty".
export function trackedChanges(repo: string): boolean | undefined {
  const status = gitMaybe(repo, ['status', '--porcelain', '--untracked-files=no']);
  return status === undefined ? undefined : status !== '';
}

export interface FetchResult {
  line: string;
  // True only when a fetch was attempted and failed. "skipped (no origin
  // remote)" is not a failure: there was no fetch to fail, and the target's
  // local state is as trustworthy as it ever gets.
  failed: boolean;
}

// Runs `git fetch --prune origin` and returns a one-line result for the
// per-workspace report. Never throws: a bad remote in one workspace must not
// stop the loop over the others.
export function fetchOrigin(repo: string): FetchResult {
  const remotes = gitMaybe(repo, ['remote']);
  if (remotes === undefined) {
    return { line: 'failed: git could not list remotes', failed: true };
  }
  if (!remotes.split('\n').includes('origin')) {
    return { line: 'skipped (no origin remote)', failed: false };
  }
  try {
    // Let fetch diagnose an origin that exists but has no/malformed URL. Using
    // `remote get-url` as the existence check would silently call that case
    // "no origin" and return success.
    git(repo, ['fetch', '--prune', 'origin']);
    return { line: 'fetched origin', failed: false };
  } catch (error) {
    return { line: `failed: ${(error as Error).message}`, failed: true };
  }
}

export function nameWidth(targets: SyncTarget[]): number {
  return Math.max(4, ...targets.map((target) => target.name.length));
}
