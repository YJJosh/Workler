import { parseCommandArgs } from '../cli-utils';
import { PACKAGE_NAME } from '../constants';
import { requireRepositoryOrGroup, lockRootsWithSourcesOf } from '../core/project';
import { withProjectLocks } from '../lock';
import { fetchOrigin, listSyncTargets, nameWidth, targetLabel } from '../multi-git';
import { findWorklerRoot } from '../workspaces';

export function fetchCommand(args: string[]): void {
  const usage = `${PACKAGE_NAME} fetch`;
  const parsed = parseCommandArgs(args, {
    command: 'fetch',
    usage,
    minPositionals: 0,
    maxPositionals: 0,
  });
  if (parsed.help) {
    console.log(`usage: ${usage}

Runs \`git fetch --prune origin\` in the main project and every workspace.
Workspaces without an origin remote are skipped with a note. Under a project
group this covers every member repository of the group and of its workspaces.`);
    return;
  }

  const root = findWorklerRoot(process.cwd());
  const info = requireRepositoryOrGroup(root, 'fetch');

  withProjectLocks(lockRootsWithSourcesOf(info), 'fetch', () => {
    const targets = listSyncTargets(root);
    const width = nameWidth(targets);
    let failures = 0;
    for (const target of targets) {
      let line: string;
      if (target.broken) {
        line = `skipped (broken: ${target.broken})`;
      } else {
        const result = fetchOrigin(target.path);
        line = result.line;
        if (result.failed) failures++;
      }
      console.log(`${targetLabel(target).padEnd(width)}  ${line}`);
    }
    if (failures > 0) {
      throw new Error(`${failures} fetch${failures === 1 ? '' : 'es'} failed`);
    }
  });
}
