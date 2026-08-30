import { parseCommandArgs } from '../cli-utils';
import { PACKAGE_NAME } from '../constants';
import { ensureGitRepo } from '../git';
import { aheadBehindUpstream, branchInfo, describeAheadBehind, listSyncTargets, trackedChanges } from '../multi-git';
import { findWorklerRoot } from '../workspaces';

export function statusCommand(args: string[]): void {
  const usage = `${PACKAGE_NAME} status`;
  const parsed = parseCommandArgs(args, {
    command: 'status',
    usage,
    minPositionals: 0,
    maxPositionals: 0,
  });
  if (parsed.help) {
    console.log(`usage: ${usage}

Shows branch, upstream ahead/behind and clean/dirty state for the main
project and every workspace. Broken or missing clones are flagged.`);
    return;
  }

  const root = findWorklerRoot(process.cwd());
  ensureGitRepo(root, 'status');

  let failures = 0;
  const rows = listSyncTargets(root).map((target) => {
    if (target.broken) {
      return { name: target.name, branch: '-', upstream: '-', state: `broken: ${target.broken}` };
    }
    const head = branchInfo(target.path);
    const counts = aheadBehindUpstream(target.path);
    const changes = trackedChanges(target.path);
    if (changes === undefined) failures++;
    return {
      name: target.name,
      branch: head.detached ? `(detached ${head.branch})` : head.branch,
      upstream: counts ? describeAheadBehind(counts) : 'no upstream',
      state: changes === undefined ? 'unknown: git status failed' : changes ? 'dirty' : 'clean',
    };
  });

  const all = [{ name: 'NAME', branch: 'BRANCH', upstream: 'UPSTREAM', state: 'STATE' }, ...rows];
  const width = (key: 'name' | 'branch' | 'upstream') => Math.max(...all.map((row) => row[key].length));
  const nameWidth = width('name');
  const branchWidth = width('branch');
  const upstreamWidth = width('upstream');

  for (const row of all) {
    console.log(
      `${row.name.padEnd(nameWidth)}  ${row.branch.padEnd(branchWidth)}  ${row.upstream.padEnd(upstreamWidth)}  ${row.state}`,
    );
  }
  if (failures > 0) {
    throw new Error(`git status failed in ${failures} workspace${failures === 1 ? '' : 's'}`);
  }
}
