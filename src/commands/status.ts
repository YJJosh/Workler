import { parseCommandArgs } from '../cli-utils';
import { PACKAGE_NAME } from '../constants';
import { requireRepositoryOrGroup } from '../core/project';
import { describeHistory, historyAdvice, historyLabel, targetHistory } from '../history';
import { memberPath } from '../groups';
import { aheadBehindUpstream, branchInfo, describeAheadBehind, listSyncTargets, targetLabel, trackedChanges } from '../multi-git';
import { findWorklerRoot } from '../workspaces';

export function statusCommand(args: string[]): void {
  const usage = `${PACKAGE_NAME} status`;
  const parsed = parseCommandArgs(args, { command: 'status', usage, minPositionals: 0, maxPositionals: 0 });
  if (parsed.help) {
    console.log(`usage: ${usage}

Shows branch, upstream ahead/behind and tracked-file clean/dirty state for
main and every workspace (one row per group member). HISTORY uses remove's
offline commit-preservation proof: preserved in source, unpreserved commits,
or unknown on inspection failure. This is not file backup or permission to
remove: dirty, untracked, ignored and nested workspace files still matter.
Unsafe rows include a specific commit import example (Bash / Git Bash).`);
    return;
  }

  const root = findWorklerRoot(process.cwd());
  requireRepositoryOrGroup(root, 'status');
  let failures = 0;
  let historyFailures = 0;
  const advice: string[] = [];
  const rows = listSyncTargets(root).map((target) => {
    const name = historyLabel(targetLabel(target));
    const history = targetHistory(root, target);
    if (history?.state === 'unknown') historyFailures++;
    if (history?.state === 'unsafe' && advice.length < 60) {
      const source = target.project === undefined ? root : memberPath(root, target.project);
      advice.push(`${name}:`, ...(history.commits ?? []).map((commit) => `  ${commit}`),
        ...historyAdvice(source, target.path, history).map((line) => `  ${line}`));
    }
    const preservation = history ? describeHistory(history) : '-';
    if (target.broken) {
      return { name, branch: '-', upstream: '-', state: `broken: ${historyLabel(target.broken)}`, history: preservation };
    }
    const head = branchInfo(target.path);
    const counts = aheadBehindUpstream(target.path);
    const changes = trackedChanges(target.path);
    if (changes === undefined) failures++;
    return {
      name,
      branch: historyLabel(head.detached ? `(detached ${head.branch})` : head.branch),
      upstream: counts ? describeAheadBehind(counts) : 'no upstream',
      state: changes === undefined ? 'unknown: git status failed' : changes ? 'dirty' : 'clean',
      history: preservation,
    };
  });

  const all = [{ name: 'NAME', branch: 'BRANCH', upstream: 'UPSTREAM', state: 'STATE', history: 'HISTORY' }, ...rows];
  const width = (key: 'name' | 'branch' | 'upstream' | 'state') => all.reduce((max, row) => Math.max(max, row[key].length), 0);
  for (const row of all) {
    console.log(`${row.name.padEnd(width('name'))}  ${row.branch.padEnd(width('branch'))}  ${row.upstream.padEnd(width('upstream'))}  ${row.state.padEnd(width('state'))}  ${row.history}`);
  }
  if (advice.length) console.log('\n' + advice.join('\n'));
  if (failures > 0) throw new Error(`git status failed in ${failures} workspace${failures === 1 ? '' : 's'}`);
  if (historyFailures > 0) throw new Error(`history inspection unknown in ${historyFailures} workspace(s); normal remove is blocked`);
}
