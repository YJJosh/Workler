import { parseCommandArgs } from '../cli-utils';
import { PACKAGE_NAME, ROOT_REMOTE } from '../constants';
import { canonicalPath, pathsReferToSameLocation } from '../fs-utils';
import { ensureGitRepo, git, gitMaybe } from '../git';
import { withProjectLock } from '../lock';
import { listSyncTargets } from '../multi-git';
import { findWorklerRoot } from '../workspaces';
import type { SyncTarget } from '../multi-git';

interface RootBranch {
  branch: string;
  sha: string;
}

export function branchSyncCommand(args: string[]): void {
  const usage = `${PACKAGE_NAME} branch-sync`;
  const parsed = parseCommandArgs(args, {
    command: 'branch-sync',
    usage,
    minPositionals: 0,
    maxPositionals: 0,
  });
  if (parsed.help) {
    console.log(`usage: ${usage}

Syncs local branches between the main project and every workspace:
  - ensures each workspace has a "${ROOT_REMOTE}" remote pointing at the root
  - creates the root's local branches in every workspace, and fast-forwards
    branches that are strictly behind the root
  - mirrors each workspace's local branches into the root as read-only refs
    under refs/workler/<workspace>/<branch>

The branch checked out in a workspace and any branch that has diverged (or
has local-only commits) are never touched; they are skipped with a note.`);
    return;
  }

  const root = findWorklerRoot(process.cwd());
  ensureGitRepo(root, 'branch-sync');
  withProjectLock(root, 'branch-sync', () => branchSyncAll(root));
}

function branchSyncAll(root: string): void {
  const rootBranches = listLocalBranches(root);
  const targets = listSyncTargets(root).filter((target) => target.path !== root);
  let failures = 0;
  if (targets.length === 0) {
    console.log('no workspaces');
    failures += pruneRemovedWorkspaceRefs(root, targets);
    if (failures > 0) throw new Error(`${failures} branch-sync operation failed`);
    return;
  }

  for (const target of targets) {
    console.log(`workspace ${target.name}`);
    if (target.broken) {
      console.log(`  skipped (broken: ${target.broken})`);
      continue;
    }
    try {
      failures += syncWorkspaceBranches(root, target, rootBranches);
    } catch (error) {
      failures++;
      console.log(`  failed: ${(error as Error).message}`);
    }
  }

  console.log('root refs (read-only, refs/workler/<workspace>/<branch>)');
  for (const target of targets) {
    const line = mirrorIntoRoot(root, target);
    if (line.startsWith('failed:')) failures++;
    console.log(`  ${target.name}  ${line}`);
  }
  failures += pruneRemovedWorkspaceRefs(root, targets);
  if (failures > 0) {
    throw new Error(`${failures} branch-sync operation${failures === 1 ? '' : 's'} failed`);
  }
}

// Mirrored refs live in the root forever unless something deletes them, so a
// removed workspace would leave a stale refs/workler/<workspace>/ namespace
// behind. Delete every namespace whose workspace is no longer present (broken
// workspaces still have a directory, so they stay in `targets` and keep their
// refs).
function pruneRemovedWorkspaceRefs(root: string, targets: SyncTarget[]): number {
  const current = new Set(targets.map((target) => target.name));
  const output = git(root, ['for-each-ref', '--format=%(refname)', 'refs/workler/']);
  if (!output) {
    return 0;
  }

  const stale = new Map<string, string[]>();
  for (const ref of output.split('\n')) {
    const rest = ref.slice('refs/workler/'.length);
    const separator = rest.indexOf('/');
    // Workspace names never contain "/" (validateWorkspaceName), so the first
    // segment is the workspace; the remainder is the branch (which may itself
    // contain slashes).
    const workspace = separator === -1 ? rest : rest.slice(0, separator);
    if (!current.has(workspace)) {
      const refs = stale.get(workspace) ?? [];
      refs.push(ref);
      stale.set(workspace, refs);
    }
  }

  let failures = 0;
  for (const [workspace, refs] of stale) {
    try {
      for (const ref of refs) {
        git(root, ['update-ref', '-d', ref]);
      }
      console.log(`  pruned refs/workler/${workspace}/ (workspace removed)`);
    } catch (error) {
      failures++;
      console.log(`  failed to prune refs/workler/${workspace}/: ${(error as Error).message}`);
    }
  }
  return failures;
}

function listLocalBranches(repo: string): RootBranch[] {
  const output = git(repo, ['for-each-ref', '--format=%(refname:strip=2) %(objectname)', 'refs/heads']);
  if (!output) {
    return [];
  }
  return output.split('\n').map((line) => {
    const separator = line.lastIndexOf(' ');
    return { branch: line.slice(0, separator), sha: line.slice(separator + 1) };
  });
}

function syncWorkspaceBranches(root: string, target: SyncTarget, rootBranches: RootBranch[]): number {
  ensureRootRemote(target.path, root);

  // Make the root's branch tips (and their objects) available in the
  // workspace as refs/remotes/workler-root/*.
  git(target.path, ['fetch', '--prune', ROOT_REMOTE]);

  if (rootBranches.length === 0) {
    console.log('  (root has no local branches)');
    return 0;
  }

  // undefined when HEAD is detached; then no branch is checked out and every
  // branch is safe to move.
  const checkedOut = gitMaybe(target.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const width = Math.max(...rootBranches.map((entry) => entry.branch.length));

  let failures = 0;
  for (const entry of rootBranches) {
    const line = syncBranch(target.path, entry, checkedOut);
    if (line.startsWith('failed:')) failures++;
    console.log(`  ${entry.branch.padEnd(width)}  ${line}`);
  }
  return failures;
}

function ensureRootRemote(repo: string, root: string): void {
  const canonicalRoot = canonicalPath(root);
  const url = gitMaybe(repo, ['remote', 'get-url', ROOT_REMOTE]);
  if (url === undefined) {
    git(repo, ['remote', 'add', ROOT_REMOTE, canonicalRoot]);
    console.log(`  added remote ${ROOT_REMOTE} -> ${canonicalRoot}`);
  } else if (!pathsReferToSameLocation(url, canonicalRoot)) {
    git(repo, ['remote', 'set-url', ROOT_REMOTE, canonicalRoot]);
    console.log(`  updated remote ${ROOT_REMOTE} -> ${canonicalRoot}`);
  }
}

function syncBranch(repo: string, rootBranch: RootBranch, checkedOut: string | undefined): string {
  const { branch, sha } = rootBranch;
  const localSha = gitMaybe(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);

  if (localSha === undefined) {
    try {
      git(repo, ['branch', branch, sha]);
      return 'created';
    } catch (error) {
      return `failed: ${(error as Error).message}`;
    }
  }
  if (localSha === sha) {
    return 'up-to-date';
  }
  if (branch === checkedOut) {
    return 'skipped (checked out)';
  }
  // Move the branch only when it is strictly behind the root's tip; a branch
  // with local-only commits (ahead or truly diverged) is never touched.
  if (gitMaybe(repo, ['merge-base', '--is-ancestor', localSha, sha]) === undefined) {
    return 'skipped (diverged)';
  }
  try {
    // update-ref with the expected old value: refuses if the branch moved
    // between our read and the update.
    git(repo, ['update-ref', `refs/heads/${branch}`, sha, localSha]);
    return 'fast-forwarded';
  } catch (error) {
    return `failed: ${(error as Error).message}`;
  }
}

// Fetches the workspace's local branches into the root as namespaced,
// read-only refs (no local branches are created in the root). Returns a
// one-line result for the report.
function mirrorIntoRoot(root: string, target: SyncTarget): string {
  if (target.broken) {
    return `skipped (broken: ${target.broken})`;
  }
  try {
    git(root, ['fetch', '--prune', target.path, `+refs/heads/*:refs/workler/${target.name}/*`]);
    const refs = git(root, ['for-each-ref', '--format=%(refname)', `refs/workler/${target.name}`]);
    const count = refs ? refs.split('\n').length : 0;
    return `${count} branch${count === 1 ? '' : 'es'} -> refs/workler/${target.name}/`;
  } catch (error) {
    return `failed: ${(error as Error).message}`;
  }
}
