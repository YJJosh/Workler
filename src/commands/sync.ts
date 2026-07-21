import { parseCommandArgs } from '../cli-utils';
import { ensureGitRepo, git } from '../git';
import { withProjectLock } from '../lock';
import {
  aheadBehindUpstream,
  branchInfo,
  fetchOrigin,
  listSyncTargets,
  nameWidth,
  trackedChanges,
} from '../multi-git';
import { findWorklerRoot } from '../workspaces';
import type { CliContext } from '../types';
import type { SyncTarget } from '../multi-git';

export function syncCommand(args: string[], context: CliContext): void {
  const usage = `${context.cliName} sync`;
  const parsed = parseCommandArgs(args, {
    command: 'sync',
    usage,
    minPositionals: 0,
    maxPositionals: 0,
  });
  if (parsed.help) {
    console.log(`usage: ${usage}

Fetches origin (with --prune) in the main project and every workspace, then
fast-forwards each current branch that has an upstream. Workspaces with
uncommitted changes are never touched, and diverged branches are never
merged or rebased - both are skipped with a note.`);
    return;
  }

  const root = findWorklerRoot(process.cwd(), context.cliName);
  ensureGitRepo(root, 'sync');
  withProjectLock(root, 'sync', () => syncAll(root));
}

function syncAll(root: string): void {
  const targets = listSyncTargets(root);
  const width = nameWidth(targets);

  // A target whose fetch FAILED must not be updated: its origin/* refs are
  // stale, so a fast-forward (or an "up to date" line) would silently mask
  // the failure. Targets with no origin remote had no fetch to fail and keep
  // the normal update behavior.
  const fetchFailed = new Set<string>();

  console.log('fetching:');
  for (const target of targets) {
    let line: string;
    if (target.broken) {
      line = `skipped (broken: ${target.broken})`;
    } else {
      const result = fetchOrigin(target.path);
      line = result.line;
      if (result.failed) {
        fetchFailed.add(target.path);
      }
    }
    console.log(`  ${target.name.padEnd(width)}  ${line}`);
  }

  console.log('');
  console.log('updating:');
  let updateFailures = 0;
  for (const target of targets) {
    const result = fetchFailed.has(target.path)
      ? { line: 'skipped (fetch failed)', failed: false }
      : syncTarget(target);
    if (result.failed) updateFailures++;
    console.log(`  ${target.name.padEnd(width)}  ${result.line}`);
  }

  const failures = fetchFailed.size + updateFailures;
  if (failures > 0) {
    throw new Error(`${failures} sync operation${failures === 1 ? '' : 's'} failed`);
  }
}

interface SyncResult {
  line: string;
  failed: boolean;
}

function syncTarget(target: SyncTarget): SyncResult {
  if (target.broken) {
    return { line: `skipped (broken: ${target.broken})`, failed: false };
  }

  const head = branchInfo(target.path);
  if (head.detached) {
    return { line: `skipped (detached HEAD at ${head.branch})`, failed: false };
  }

  // Safety first: never touch a workspace with uncommitted changes to
  // tracked files, even if a fast-forward would probably succeed. Untracked
  // files (e.g. from copy rules) do not block a sync: git itself refuses a
  // merge that would overwrite one.
  const changes = trackedChanges(target.path);
  if (changes === undefined) {
    return { line: 'failed: git status could not inspect tracked changes', failed: true };
  }
  if (changes) {
    return { line: 'skipped (uncommitted changes)', failed: false };
  }

  const counts = aheadBehindUpstream(target.path);
  if (!counts) {
    return { line: `skipped (no upstream for ${head.branch})`, failed: false };
  }
  if (counts.behind === 0) {
    return {
      line: counts.ahead > 0 ? `up to date (ahead ${counts.ahead})` : 'up to date',
      failed: false,
    };
  }
  if (counts.ahead > 0) {
    return { line: `diverged, skipped (ahead ${counts.ahead}, behind ${counts.behind})`, failed: false };
  }

  try {
    git(target.path, ['merge', '--ff-only', '@{upstream}']);
    return {
      line: `fast-forwarded ${head.branch} (${counts.behind} commit${counts.behind === 1 ? '' : 's'})`,
      failed: false,
    };
  } catch (error) {
    return { line: `failed: ${(error as Error).message}`, failed: true };
  }
}
